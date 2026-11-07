// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Over HTTP: security events reach the audit log, the access log filters them,
 * an OAuth app's "send without approval" flag is session-only, and the
 * approvals routes approve once, reject, and refuse self-approval.
 *
 * Assembled like `test/auth-routes.test.ts`: the real auth middleware and
 * routes, the real API app, a real AuthStore over node:sqlite, and approvals
 * in real SQLite with the MailboxDO migrations applied.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { app as apiApp } from "../workers/index";
import { createAuthGate, createAuthenticate, type AuthDeps } from "../workers/auth/middleware";
import { createAuthRoutes } from "../workers/auth/routes";
import { hotp, base32Decode, totpStep } from "../workers/auth/totp";
import { csrfGuard } from "../workers/lib/csrf";
import type { MailboxContext } from "../workers/lib/mailbox";
import * as approvalsDo from "../workers/durableObject/approvals";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { auditEntryMatches } from "../workers/lib/audit";
import { decisionRefusal, tokensRelated } from "../workers/routes/approvals";
import type { Env } from "../workers/types";
import { sqliteAuthStore } from "./helpers/suppression-store";
import { prepareOutgoingHtml } from "../shared/outgoing-html";

const ORIGIN = "https://mail.example.com";
const SETUP_TOKEN = "correct-horse-battery-staple";
const OWNER = { email: "owner@example.com", name: "Olivia Owner", password: "owner-password-1" };
const SUPPORT = "support@example.com";

function fakeBucket() {
	const store = new Map<string, string>([[`mailboxes/${SUPPORT}.json`, JSON.stringify({ fromName: "Support" })]]);
	return {
		store,
		async head(key: string) {
			return store.has(key) ? { key } : null;
		},
		async get(key: string) {
			const raw = store.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw) };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string | string[]) {
			for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
		},
		async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) {
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: false as const };
		},
	};
}

function doContext() {
	const db = new DatabaseSync(":memory:");
	const exec = (query: string, ...bindings: unknown[]) => {
		const q = query.trim();
		if (/^(select|with)/i.test(q) || /\breturning\b/i.test(q)) {
			const rows = db.prepare(q).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		}
		if (bindings.length === 0) db.exec(q);
		else db.prepare(q).run(...(bindings as never[]));
		return { toArray: () => [], one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
	};
	const ctx = { storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn() } } as unknown as DurableObjectState;
	applyMigrations(ctx.storage.sql, mailboxMigrations, ctx.storage);
	return ctx;
}

function build() {
	const store = sqliteAuthStore();
	const bucket = fakeBucket();
	const ctx = doContext();
	const clock = { now: Date.UTC(2026, 9, 26) };
	const sent: { to: unknown; subject: string }[] = [];
	const stub = {
		getSendApproval: async (id: string) => approvalsDo.getApproval(ctx, id),
		listSendApprovals: async (o: never) => approvalsDo.listApprovals(ctx, o),
		countPendingSendApprovals: async () => approvalsDo.countPendingApprovals(ctx),
		claimSendApproval: async (id: string, o: never) => approvalsDo.claimApproval(ctx, id, o),
		finishSendApproval: async (id: string, fence: string, o: never) => approvalsDo.finishApproval(ctx, id, fence, o),
		createSendApproval: async (i: approvalsDo.CreateApprovalInput) => approvalsDo.createApproval(ctx, i),
		updatePendingSendApproval: async (id: string, u: never) => approvalsDo.updatePendingApproval(ctx, id, u),
		recordDelivery: async () => null,
		markThreadRead: async () => null,
		createScheduledEmail: async () => null,
		rejectSendApproval: async (id: string, o: never) => approvalsDo.rejectApproval(ctx, id, o),
		reopenSendApproval: async (id: string) => approvalsDo.reopenApproval(ctx, id),
		// What a replayed send_email touches. The provider send is counted.
		checkSendRateLimit: async () => null,
		createEmail: async () => null,
		appendDeliveryEvent: async () => null,
		getTrackingSettings: async () => ({ openTracking: false, clickTracking: false, attachmentTracking: false }),
		getOrCreateTrackingSecret: async () => "s".repeat(64),
		idempotencyBegin: async () => ({ kind: "proceed" }),
		idempotencyComplete: async () => true,
		idempotencyRelease: async () => undefined,
	};
	const env = {
		EMAIL: {
			async send(message: { to: unknown; subject: string }) {
				sent.push(message);
				return { messageId: `msg-${sent.length}` };
			},
		},
		AI: { run: async (_m: string, input: { messages: { content: string }[] }) => ({ response: input.messages.at(-1)?.content ?? "" }) },
		DOMAINS: "example.com",
		SETUP_TOKEN,
		AUTH_SECRET: "test-auth-secret",
		BUCKET: bucket,
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => stub },
		AUTH_STORE: { idFromName: (n: string) => n, get: () => store },
	} as unknown as Env;

	const deps: AuthDeps = { getStore: () => store, isDev: false, now: () => clock.now };
	const app = new Hono<MailboxContext>();
	app.use("*", csrfGuard);
	app.use("*", createAuthenticate(deps));
	app.route("/api/auth", createAuthRoutes(deps));
	app.use("*", createAuthGate(deps));
	app.route("/", apiApp);

	const pending: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (p: Promise<unknown>) => void pending.push(p),
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;
	const request = (path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) => {
		const { cookie, bearer, ...rest } = init;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Sec-Fetch-Site": "same-origin",
			"cf-connecting-ip": "203.0.113.7",
			...(rest.headers as Record<string, string>),
		};
		if (cookie) headers.Cookie = cookie;
		if (bearer) headers.Authorization = `Bearer ${bearer}`;
		return Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }), env, executionCtx));
	};
	const settle = async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};
	return { request, store, bucket, ctx, clock, env, sent, settle };
}

type H = ReturnType<typeof build>;

const post = (body: unknown, extra: RequestInit & { cookie?: string; bearer?: string } = {}) => ({
	method: "POST",
	body: JSON.stringify(body),
	...extra,
});

function cookieFrom(res: Response): string {
	const header = res.headers.get("set-cookie");
	if (!header) throw new Error("no Set-Cookie");
	return header.split(";")[0];
}

async function setupOwner(h: H): Promise<string> {
	const res = await h.request("/api/auth/setup", post({ setupToken: SETUP_TOKEN, ...OWNER }));
	expect(res.status).toBe(201);
	return cookieFrom(res);
}

async function instanceAudit(h: H) {
	await h.settle();
	return [...h.bucket.store.entries()]
		.filter(([k]) => k.startsWith("audit/_instance/"))
		.map(([, v]) => JSON.parse(v) as { action: string; actor: string | null; target?: string; detail?: Record<string, unknown> });
}

describe("security events are audited", () => {
	let h: H;
	beforeEach(() => {
		h = build();
	});

	it("records sign-in success, failure and sign-out with the IP, never the password", async () => {
		await setupOwner(h);
		expect((await h.request("/api/auth/login", post({ email: OWNER.email, password: "wrong-password-x" }))).status).toBe(401);
		const cookie = cookieFrom(await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password })));
		await h.request("/api/auth/logout", post({}, { cookie }));

		const entries = await instanceAudit(h);
		expect(entries.find((e) => e.action === "auth.login_failed")).toMatchObject({
			actor: null,
			target: OWNER.email,
			detail: { reason: "wrong_password", ip: "203.0.113.7" },
		});
		expect(entries.find((e) => e.action === "auth.login")).toMatchObject({ actor: OWNER.email, detail: { method: "password" } });
		expect(entries.some((e) => e.action === "auth.logout" && e.actor === OWNER.email)).toBe(true);
		expect(JSON.stringify(entries)).not.toContain("wrong-password-x");
	});

	it("records password change, session revocation and token create/revoke", async () => {
		const cookie = await setupOwner(h);
		await h.request("/api/auth/password", post({ currentPassword: OWNER.password, newPassword: "owner-password-2" }, { cookie }));
		await h.request("/api/auth/sessions/revoke-others", post({}, { cookie }));
		const created = await h.request("/api/auth/tokens", post({ name: "ci", scopes: ["mail:read"] }, { cookie }));
		const { token } = (await created.json()) as { token: { id: string } };
		await h.request(`/api/auth/tokens/${token.id}`, { method: "DELETE", cookie });

		const entries = await instanceAudit(h);
		expect(entries.map((e) => e.action)).toEqual(
			expect.arrayContaining(["auth.password_change", "auth.session_revoke", "auth.token_create", "auth.token_revoke"]),
		);
		expect(entries.find((e) => e.action === "auth.token_create")?.detail).toMatchObject({ name: "ci", scopes: "mail:read" });
		expect(JSON.stringify(entries)).not.toMatch(/ttk_/);
	});

	it("records 2FA enable and disable", async () => {
		const cookie = await setupOwner(h);
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const code = (t: number) => hotp(base32Decode(secret), totpStep(t));
		expect((await h.request("/api/auth/2fa/enable", post({ code: await code(h.clock.now) }, { cookie }))).status).toBe(200);
		h.clock.now += 60_000;
		expect(
			(await h.request("/api/auth/2fa/disable", post({ password: OWNER.password, code: await code(h.clock.now) }, { cookie }))).status,
		).toBe(204);
		const actions = (await instanceAudit(h)).map((e) => e.action);
		expect(actions).toContain("auth.2fa_enable");
		expect(actions).toContain("auth.2fa_disable");
	});

	it("the access log filters by category and actor", async () => {
		const cookie = await setupOwner(h);
		await h.request("/api/auth/login", post({ email: "someone@else.example", password: "nope-nope-nope" }));
		await h.settle();
		const security = (await (await h.request("/api/v1/access/audit?category=security", { cookie })).json()) as { action: string }[];
		expect(security.length).toBeGreaterThan(0);
		expect(security.every((e) => e.action.startsWith("auth."))).toBe(true);
		const byTarget = (await (await h.request("/api/v1/access/audit?actor=someone%40else", { cookie })).json()) as { action: string }[];
		expect(byTarget.map((e) => e.action)).toEqual(["auth.login_failed"]);
	});

	it("filter matching covers the token and OAuth app", () => {
		const entry = { id: "1", at: 0, action: "agent.send_held" as const, actor: "o@x.com", actorRole: "owner" as const, mailboxId: "m@x.com", detail: { oauthClientName: "Hermes" } };
		expect(auditEntryMatches(entry, { category: "agent", actor: "hermes" })).toBe(true);
		expect(auditEntryMatches(entry, { category: "security" })).toBe(false);
	});
});

describe("OAuth app send permission", () => {
	it("only a browser session can let an app send without approval", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const owner = (await h.store.getLoginCandidate(OWNER.email))!.user;
		const grant = await h.store.createOAuthGrant({ userId: owner.id, clientId: "c1", clientName: "Hermes", redirectHost: "h.example", now: h.clock.now });
		expect(grant.sendAuto).toBe(false);

		const on = await h.request(`/api/auth/oauth-grants/${grant.id}`, { method: "PATCH", body: JSON.stringify({ sendAuto: true }), cookie });
		expect(on.status).toBe(200);
		expect((await h.store.listOAuthGrants(owner.id))[0].sendAuto).toBe(true);
		expect((await h.store.validateOAuthGrant(grant.id, owner.id, h.clock.now))?.grant.sendAuto).toBe(true);

		const t = await h.request("/api/auth/tokens", post({ name: "x" }, { cookie }));
		const { secret } = (await t.json()) as { secret: string };
		const byToken = await h.request(`/api/auth/oauth-grants/${grant.id}`, {
			method: "PATCH",
			body: JSON.stringify({ sendAuto: false }),
			bearer: secret,
		});
		expect(byToken.status).toBe(403);
		expect((await instanceAudit(h)).some((e) => e.action === "auth.oauth_send_auto")).toBe(true);

		// Revoking the app drops its setting with it.
		await h.request(`/api/auth/oauth-grants/${grant.id}`, { method: "DELETE", cookie });
		expect(await h.store.listOAuthGrants(owner.id)).toHaveLength(0);
	});
});

describe("approvals routes", () => {
	const BASE = `/api/v1/mailboxes/${encodeURIComponent(SUPPORT)}/approvals`;
	const EMAILS = `/api/v1/mailboxes/${encodeURIComponent(SUPPORT)}/emails`;
	const message = { to: "customer@example.org", from: SUPPORT, subject: "Hello", html: "<p>Hi there, a short note for you today.</p>" };

	async function token(h: H, cookie: string, name: string, scopes: string[], bearer?: string) {
		const res = await h.request("/api/auth/tokens", post({ name, scopes }, bearer ? { bearer } : { cookie }));
		expect(res.status).toBe(201);
		return (await res.json()) as { token: { id: string }; secret: string };
	}

	/** Hold a send by POSTing it with an API token, as Hermes would. */
	async function holdViaRest(h: H, secret: string) {
		const res = await h.request(EMAILS, post(message, { bearer: secret }));
		expect(res.status).toBe(202);
		const body = (await res.json()) as { status: string; approval_id: string };
		expect(body.status).toBe("pending_approval");
		return body.approval_id;
	}

	it("a token's REST send is held (202 pending_approval); a browser session's is sent", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const hermes = await token(h, cookie, "hermes", ["mail:read", "mail:send"]);
		const id = await holdViaRest(h, hermes.secret);
		await h.settle();
		expect(h.sent).toHaveLength(0);
		expect(approvalsDo.getApproval(h.ctx, id)).toMatchObject({ kind: "rest_send", status: "pending", actor: { method: "token", tokenId: hermes.token.id } });

		const bySession = await h.request(EMAILS, post(message, { cookie }));
		expect(bySession.status).toBe(202);
		expect(await bySession.json()).toMatchObject({ status: "sent" });
		await h.settle();
		expect(h.sent).toHaveLength(1);
	});

	it("lists, counts, previews the stored message, approves exactly once and rejects", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const hermes = await token(h, cookie, "hermes", ["mail:read", "mail:send"]);
		const a = await holdViaRest(h, hermes.secret);

		expect(await (await h.request(`${BASE}/count`, { cookie })).json()).toEqual({ pending: 1 });
		const listed = (await (await h.request(BASE, { cookie })).json()) as {
			approvals: { id: string; requested_by: { tokenName: string }; messages: { html: string }[]; tracking_added_at_send: boolean; editable: boolean }[];
		};
		expect(listed.approvals[0]).toMatchObject({
			id: a,
			requested_by: { tokenName: "hermes" },
			messages: [{ html: message.html }],
			tracking_added_at_send: true,
			editable: true,
		});

		const first = await h.request(`${BASE}/${a}/approve`, post({}, { cookie }));
		expect(first.status).toBe(200);
		expect((await h.request(`${BASE}/${a}/approve`, post({}, { cookie }))).status).toBe(409);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({ to: ["customer@example.org"], subject: "Hello" });
		expect(approvalsDo.getApproval(h.ctx, a)?.status).toBe("sent");

		const b = await holdViaRest(h, hermes.secret);
		expect((await h.request(`${BASE}/${b}/reject`, post({ note: "no" }, { cookie }))).status).toBe(200);
		expect(h.sent).toHaveLength(1);
		expect(approvalsDo.getApproval(h.ctx, b)?.status).toBe("rejected");

		await h.settle();
		const mailboxAudit = [...h.bucket.store.entries()].filter(([k]) => k.startsWith(`audit/${SUPPORT}/`)).map(([, v]) => JSON.parse(v).action);
		expect(mailboxAudit).toEqual(expect.arrayContaining(["agent.send_held", "approval.approve", "approval.reject"]));
	});

	it("an edit is saved separately, re-verified, and approve sends the edited stored message", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const hermes = await token(h, cookie, "hermes", ["mail:read", "mail:send"]);
		const a = await holdViaRest(h, hermes.secret);
		const edited = await h.request(`${BASE}/${a}`, {
			method: "PATCH",
			body: JSON.stringify({ subject: "Re: hello", to: "other@example.org", html: "<p>A better note for you, written by a person.</p>" }),
			cookie,
		});
		expect(edited.status).toBe(200);
		const { approval } = (await edited.json()) as { approval: { messages: { html: string; subject: string }[] } };
		expect(approval.messages[0]).toMatchObject({ subject: "Re: hello" });
		// Approve has no body: it sends what is stored.
		expect((await h.request(`${BASE}/${a}/approve`, post({}, { cookie }))).status).toBe(200);
		expect(h.sent[0]).toMatchObject({ subject: "Re: hello", to: ["other@example.org"], html: prepareOutgoingHtml(approval.messages[0]!.html) });
	});

	it("the requesting token revises its own held send in place; approving the old revision sends nothing", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const hermes = await token(h, cookie, "hermes", ["mail:read", "mail:send"]);
		const other = await token(h, cookie, "other", ["mail:read", "mail:send"]);
		const a = await holdViaRest(h, hermes.secret);

		// Another token (even with send rights) cannot revise it, and revising is not deciding.
		expect((await h.request(`${BASE}/${a}/revise`, post({ subject: "x" }, { bearer: other.secret }))).status).toBe(403);
		const revised = await h.request(
			`${BASE}/${a}/revise`,
			post({ subject: "Hello (v2)", html: "<p>A clearer second version of the note.</p>" }, { bearer: hermes.secret }),
		);
		expect(revised.status).toBe(200);
		const { approval } = (await revised.json()) as { approval: { id: string; revision: number; revised_by: string; status: string } };
		expect(approval).toMatchObject({ id: a, revision: 2, revised_by: "requester", status: "pending" });

		// Still one item in the queue.
		expect(await (await h.request(`${BASE}/count`, { cookie })).json()).toEqual({ pending: 1 });
		// The person opened it at revision 1: approving that is refused, and nothing is sent.
		const stale = await h.request(`${BASE}/${a}/approve`, post({ revision: 1 }, { cookie }));
		expect(stale.status).toBe(409);
		expect(h.sent).toHaveLength(0);
		// Older clients' extra keys and a JSON null body are still accepted.
		expect((await h.request(`${BASE}/${a}/approve`, post({ revision: 1, note: "ok" }, { cookie }))).status).toBe(409);
		expect((await h.request(`${BASE}/${a}/approve`, post({ revision: 2 }, { cookie }))).status).toBe(200);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({ subject: "Hello (v2)" });
		// Once sent it cannot be revised.
		expect((await h.request(`${BASE}/${a}/revise`, post({ subject: "v3" }, { bearer: hermes.secret }))).status).toBe(409);
	});

	it("an OAuth app can never decide, whatever its scopes", async () => {
		const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
		const c = {
			var: { authMethod: "oauth", principal: { credential: { method: "oauth" }, token: { scopes: ["approvals:manage"] } } },
			json,
		};
		const res = await decisionRefusal(c as never, null);
		expect(res?.status).toBe(403);
		expect(await res!.json()).toMatchObject({ code: "person_required" });
		const session = { var: { authMethod: "session", principal: {} }, json };
		expect(await decisionRefusal(session as never, null)).toBeNull();
	});

	it("a token without approvals:manage cannot decide, even an unrelated one", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const hermes = await token(h, cookie, "hermes", ["mail:read", "mail:send"]);
		const other = await token(h, cookie, "cli", ["mail:read", "mail:send"]);
		const a = await holdViaRest(h, hermes.secret);
		const res = await h.request(`${BASE}/${a}/approve`, post({}, { bearer: other.secret }));
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "insufficient_scope", scope: "approvals:manage" });
		expect(h.sent).toHaveLength(0);
	});

	it("approvals:manage lets an unrelated token decide, but never one in the requester's lineage", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const parent = await token(h, cookie, "hermes", ["mail:read", "mail:send", "approvals:manage"]);
		const child = await token(h, cookie, "hermes-child", ["mail:read", "mail:send", "approvals:manage"], parent.secret);
		const a = await holdViaRest(h, parent.secret);

		const self = await h.request(`${BASE}/${a}/approve`, post({}, { bearer: parent.secret }));
		expect(self.status).toBe(403);
		expect(await self.json()).toMatchObject({ code: "self_approval" });
		expect((await h.request(`${BASE}/${a}/approve`, post({}, { bearer: child.secret }))).status).toBe(403);
		expect(h.sent).toHaveLength(0);

		const cli = await token(h, cookie, "cli", ["mail:read", "mail:send", "approvals:manage"]);
		expect((await h.request(`${BASE}/${a}/approve`, post({}, { bearer: cli.secret }))).status).toBe(200);
		expect(h.sent).toHaveLength(1);
	});

	it("tokensRelated follows lineage both ways", () => {
		const tokens = [
			{ id: "root", parentId: null },
			{ id: "kid", parentId: "root" },
			{ id: "grandkid", parentId: "kid" },
			{ id: "other", parentId: null },
		];
		expect(tokensRelated(tokens, "grandkid", "root")).toBe(true);
		expect(tokensRelated(tokens, "root", "grandkid")).toBe(true);
		expect(tokensRelated(tokens, "kid", "kid")).toBe(true);
		expect(tokensRelated(tokens, "other", "kid")).toBe(false);
	});

	it("a read-only token can see the queue but not decide", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const hermes = await token(h, cookie, "hermes", ["mail:read", "mail:send"]);
		const reader = await token(h, cookie, "reader", ["mail:read"]);
		const a = await holdViaRest(h, hermes.secret);
		expect((await h.request(BASE, { bearer: reader.secret })).status).toBe(200);
		expect((await h.request(`${BASE}/${a}/approve`, post({}, { bearer: reader.secret }))).status).toBe(403);
		expect(h.sent).toHaveLength(0);
	});

	it("only a person can change the agent send policy", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const admin = await token(h, cookie, "ops", ["admin"]);
		const MBX = `/api/v1/mailboxes/${encodeURIComponent(SUPPORT)}`;
		const byToken = await h.request(MBX, { method: "PUT", body: JSON.stringify({ settings: { agentSend: { mode: "auto" } } }), bearer: admin.secret });
		expect(byToken.status).toBe(403);
		const bySession = await h.request(MBX, { method: "PUT", body: JSON.stringify({ settings: { agentSend: { mode: "auto" } } }), cookie });
		expect(bySession.status).toBe(200);
	});

	it("a held sequence enrollment previews the sequence and its steps", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const hermes = await token(h, cookie, "hermes", ["mail:read", "mail:send"]);
		h.bucket.store.set("templates/welcome.json", JSON.stringify({ slug: "welcome", name: "Welcome", subject: "Welcome {{name}}", bodyHtml: "<p>Hi {{name}}</p>", variables: ["name"], createdAt: 0, updatedAt: 0 }));
		h.bucket.store.set("sequences/seq1.json", JSON.stringify({ id: "seq1", name: "Onboarding", steps: [{ order: 1, templateSlug: "welcome", delayHours: 0 }], createdAt: 0, updatedAt: 0 }));
		const res = await h.request(
			"/api/v1/sequences/seq1/enroll",
			post({ personId: "p1", personEmail: "new@example.org", personName: "Ada", fromAddress: SUPPORT }, { bearer: hermes.secret }),
		);
		expect(res.status).toBe(202);
		const { approval_id } = (await res.json()) as { approval_id: string };
		const view = (await (await h.request(`${BASE}/${approval_id}`, { cookie })).json()) as {
			approval: { kind: string; enrollment: { sequence_name: string; steps: { subject: string }[] } };
		};
		expect(view.approval).toMatchObject({ kind: "sequence_enroll", enrollment: { sequence_name: "Onboarding", steps: [{ subject: "Welcome Ada" }] } });
	});
});
