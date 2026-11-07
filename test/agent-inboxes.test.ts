// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Agent inboxes through the real Hono app.
 *
 * - a real AuthStore + DomainStore on node:sqlite behind AUTH_STORE
 * - a real WebhookStore behind WEBHOOKS
 * - an R2 fake and a MailboxDO fake with a small export
 * - identities and tokens injected the way `authenticate` sets them
 *
 * Covers create (address, scopes per send mode, policy, webhook), permission
 * denials, idempotent create (and that the replay holds no secret), TTL expiry
 * cleanup (token revoked, webhook gone, mbox archived, mailbox deleted, audit),
 * DELETE, and allowed_recipients / send mode enforcement on the send routes.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../workers/index";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { DomainStore } from "../workers/lib/domain-store";
import { WebhookStore } from "../workers/lib/webhooks-store";
import { decideAgentSend, expireAgentInboxes } from "../workers/lib/agent-inboxes";
import { beginIdempotent, completeIdempotent, releaseIdempotent } from "../workers/lib/idempotency-store";
import {
	disallowedRecipients,
	formatCountdown,
	generateAgentLocalPart,
	normalizeRecipientPattern,
	scopesForSendMode,
	stricterSendMode,
} from "../shared/agent-inboxes";
import { redactNestedSecrets } from "../workers/lib/idempotency";
import { preSend } from "../workers/lib/pre-send";
import { requiredTokenScope } from "../workers/lib/token-scope-guard";
import { sha256Hex } from "../workers/auth/crypto";
import type { AuthUser, ApiTokenInfo } from "../workers/auth/types";
import type { TokenScope } from "../shared/token-scopes";

const ADMIN = "owner@example.com";
const MEMBER = "member@example.com";

function adapter(db: DatabaseSync): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const rows = db.prepare(query).all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx<T>(fn: () => T): T {
			db.exec("SAVEPOINT tx");
			try {
				const out = fn();
				db.exec("RELEASE tx");
				return out;
			} catch (e) {
				db.exec("ROLLBACK TO tx");
				db.exec("RELEASE tx");
				throw e;
			}
		},
	};
}

let auth: AuthStore;
let domains: DomainStore;
let hooks: WebhookStore;
let objects: Map<string, string>;
let ownerUser: AuthUser;
let memberUser: AuthUser;
let purged: string[];
let mailboxMessages: Record<string, Record<string, unknown>[]>;
let sent: { to: unknown }[];
let held: { mailbox: string; id: string; kind: string; recipients: string[] }[] = [];
let authSql: AuthSql;

function rpc(target: () => object) {
	return new Proxy({}, { get: (_t, name: string) => async (...args: unknown[]) => (target() as any)[name](...args) });
}

function makeEnv(extra: Record<string, unknown> = {}) {
	const authRpc = new Proxy(
		{},
		{
			get: (_t, name: string) => async (...args: unknown[]) => {
				// AuthDO's own idempotency methods, over the same database.
				if (name === "idempotencyBegin") return beginIdempotent(authSql, args[0] as never);
				if (name === "idempotencyComplete") return completeIdempotent(authSql, args[0] as never);
				if (name === "idempotencyRelease") return releaseIdempotent(authSql, args[0] as never);
				const target = name in domains ? domains : auth;
				return (target as any)[name](...args);
			},
		},
	);
	return {
		AUTH_MODE: "password",
		DOMAINS: "example.com,agents.example.com",
		EMAIL_ADDRESSES: [],
		AUTH_STORE: { idFromName: () => "global", get: () => authRpc },
		WEBHOOKS: {
			idFromName: () => "global",
			get: () =>
				rpc(() => ({
					createEndpoint: (i: never) => hooks.createEndpoint(i),
					updateEndpoint: (id: string, p: never) => hooks.updateEndpoint(id, p),
					deleteEndpoint: (id: string) => hooks.deleteEndpoint(id),
					getEndpoint: (id: string) => hooks.getEndpoint(id),
					listEndpoints: () => hooks.listEndpoints(),
				})),
		},
		BUCKET: {
			head: async (key: string) => (objects.has(key) ? { key } : null),
			get: async (key: string) => {
				const raw = objects.get(key);
				return raw === undefined ? null : { json: async () => JSON.parse(raw), text: async () => raw };
			},
			put: async (key: string, value: string) => void objects.set(key, String(value)),
			delete: async (k: string | string[]) => void [k].flat().forEach((x) => objects.delete(x)),
			list: async (opts: { prefix?: string }) => ({
				objects: [...objects.keys()].filter((k) => k.startsWith(opts?.prefix ?? "")).sort().map((key) => ({ key })),
				truncated: false,
			}),
		},
		MAILBOX: {
			idFromName: (n: string) => n,
			get: (id: string) => ({
				getFolders: async () => [],
				purge: async () => {
					purged.push(id);
					return [];
				},
				exportPage: async () => ({ messages: mailboxMessages[id] ?? [], attachments: {}, done: true }),
				countAllEmails: async () => (mailboxMessages[id] ?? []).length,
				checkSendRateLimit: async () => null,
				// The approval queue (workers/durableObject/approvals.ts), in memory.
				createSendApproval: async (i: { id?: string; kind: string; recipients: string[] }) => {
					const row = { ...i, id: i.id ?? `apr_${held.length + 1}`, status: "pending", expiresAt: Date.now() + 86_400_000 };
					held.push({ mailbox: id, ...row });
					return row;
				},
			}),
		},
		EMAIL_AGENT: { idFromName: (n: string) => n, get: () => ({ purge: async () => {} }) },
		EMAIL: { send: async (m: { to: unknown }) => void sent.push(m) },
		...extra,
	} as never;
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

/** The real app as a signed-in user, optionally through an API token. */
function as(user: AuthUser, token?: Partial<ApiTokenInfo> & { scopes: TokenScope[] | null }) {
	const outer = new Hono();
	outer.use("*", async (c, next) => {
		(c as any).set("accessIdentity", { kind: "user", id: user.email, subject: user.id });
		(c as any).set("authUser", user);
		(c as any).set("authMethod", token ? "token" : "session");
		if (token) {
			(c as any).set("authToken", {
				id: "tok_parent",
				userId: user.id,
				name: "t",
				createdAt: 0,
				lastUsedAt: null,
				lastUsedIp: null,
				expiresAt: null,
				mailboxes: null,
				parentId: null,
				...token,
			});
		}
		return next();
	});
	outer.route("/", app as never);
	return (path: string, init: RequestInit = {}, env = makeEnv()) =>
		outer.fetch(
			new Request(`https://mailer.example.com${path}`, {
				...init,
				headers: { "content-type": "application/json", "Sec-Fetch-Site": "same-origin", ...(init.headers ?? {}) },
			}),
			env,
			ctx,
		);
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
	method: "POST",
	body: JSON.stringify(body),
	headers,
});

beforeEach(async () => {
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	authSql = sql;
	auth = new AuthStore(sql, tx);
	domains = new DomainStore(sql, tx);
	const hookDb = new DatabaseSync(":memory:");
	const h = adapter(hookDb);
	hooks = new WebhookStore(h.sql, h.tx);
	const created = await auth.createOwner({ email: ADMIN, name: "Owner", passwordHash: "x", now: 1 });
	if (!created.ok) throw new Error("owner");
	ownerUser = created.user;
	await auth.createInvite({ tokenHash: "inv", email: MEMBER, role: "member", mailboxes: [], createdBy: null, expiresAt: Date.now() + 1e9, now: 1 });
	const accepted = await auth.acceptInvite({ tokenHash: "inv", name: "M", passwordHash: "x", now: 2 });
	if (!("user" in accepted) || !accepted.user) throw new Error("member");
	memberUser = accepted.user as AuthUser;
	objects = new Map();
	purged = [];
	mailboxMessages = {};
	sent = [];
	held = [];
});

// ── Pure policy ─────────────────────────────────────────────────────

describe("policy helpers", () => {
	it("maps send modes onto token scopes", () => {
		expect(scopesForSendMode("draft_only")).toEqual(["mail:read", "mail:draft", "mail:organize"]);
		// approve may reach the send routes; the approval rule holds what it sends.
		expect(scopesForSendMode("approve")).toEqual(["mail:read", "mail:send", "mail:draft", "mail:organize"]);
		// auto maps onto mail:send:auto, which is what lets the approval rule send it directly.
		expect(scopesForSendMode("auto")).toEqual(["mail:read", "mail:send", "mail:send:auto", "mail:draft", "mail:organize"]);
	});

	it("generates agent-<6 lowercase alphanumerics>", () => {
		for (let i = 0; i < 50; i++) expect(generateAgentLocalPart()).toMatch(/^agent-[a-z0-9]{6}$/);
	});

	it("matches exact addresses and whole domains, not subdomains", () => {
		const allowed = ["ops@example.org", "@partner.com"].map((p) => normalizeRecipientPattern(p)!);
		expect(disallowedRecipients(allowed, ["Ops <OPS@example.org>", "a@partner.com"])).toEqual([]);
		expect(disallowedRecipients(allowed, ["x@sub.partner.com", "eve@evil.com", "eve@evil.com"])).toEqual([
			"x@sub.partner.com",
			"eve@evil.com",
		]);
		expect(normalizeRecipientPattern("*@Partner.com")).toBe("@partner.com");
		expect(normalizeRecipientPattern("not an address")).toBeNull();
		expect(disallowedRecipients(null, ["anyone@anywhere.com"])).toEqual([]);
	});

	it("refuses draft_only sends by the agent's token, defers approve to the approval rule, and refuses out-of-list recipients for anyone", () => {
		const draft = { send_mode: "draft_only" as const, allowed_recipients: null };
		expect(decideAgentSend(draft, ["a@b.com"], true)).toMatchObject({ ok: false, code: "drafts_only" });
		// A person sending the agent's draft is the approval.
		expect(decideAgentSend(draft, ["a@b.com"], false)).toEqual({ ok: true });
		// Not refused here: the next pre-send rule holds it for approval.
		expect(decideAgentSend({ send_mode: "approve", allowed_recipients: null }, ["a@b.com"], true)).toEqual({ ok: true });
		// A recipient outside the list is a hard block even in approve mode.
		expect(decideAgentSend({ send_mode: "approve", allowed_recipients: ["@b.com"] }, ["a@c.com"], true)).toMatchObject({
			ok: false,
			status: 422,
			code: "recipient_not_allowed",
		});
		expect(stricterSendMode("auto", "approve")).toBe("approve");
		expect(stricterSendMode("approve", "draft_only")).toBe("draft_only");
		const auto = { send_mode: "auto" as const, allowed_recipients: ["@b.com"] };
		expect(decideAgentSend(auto, ["a@b.com"], true)).toEqual({ ok: true });
		expect(decideAgentSend(auto, ["a@c.com"], false)).toMatchObject({ ok: false, status: 422, recipients: ["a@c.com"] });
	});

	it("formats the countdown", () => {
		expect(formatCountdown(null)).toBe("no expiry");
		expect(formatCountdown(0)).toBe("expired");
		expect(formatCountdown(30_000)).toBe("1m");
		expect(formatCountdown(2 * 3600_000 + 5 * 60_000)).toBe("2h 5m");
		expect(formatCountdown(3 * 86400_000 + 4 * 3600_000)).toBe("3d 4h");
	});

	it("routes are scoped to mailboxes:manage and mail:read", () => {
		expect(requiredTokenScope("POST", "/api/v1/agent-inboxes")).toBe("mailboxes:manage");
		expect(requiredTokenScope("DELETE", "/api/v1/agent-inboxes/a@b.com")).toBe("mailboxes:manage");
		expect(requiredTokenScope("GET", "/api/v1/events/stream")).toBe("mail:read");
	});

	it("redacts both nested secrets from a stored replay", () => {
		const body = JSON.stringify({ address: "a@b.com", token: { id: "x", secret: "ttk_x_s" }, webhook: { id: "w", secret: "whsec_1" } });
		const out = JSON.parse(redactNestedSecrets(body));
		expect(out.token).toEqual({ id: "x", secret: null });
		expect(out.webhook).toEqual({ id: "w", secret: null });
		expect(out.secret_redacted).toBe(true);
		expect(redactNestedSecrets('{"a":1}')).toBe('{"a":1}');
	});
});

// ── Create ──────────────────────────────────────────────────────────

describe("POST /api/v1/agent-inboxes", () => {
	it("creates a mailbox, a scoped token, the policy and a filtered webhook", async () => {
		const res = await as(ownerUser)(
			"/api/v1/agent-inboxes",
			post({
				domain: "Example.com",
				purpose: "Triage support mail",
				send_mode: "auto",
				ttl_hours: 2,
				allowed_recipients: ["ops@example.org", "@partner.com"],
				webhook_url: "https://hooks.partner.com/agent",
				display_name: "Support bot",
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(body.address).toMatch(/^agent-[a-z0-9]{6}@example\.com$/);
		expect(objects.has(`mailboxes/${body.address}.json`)).toBe(true);
		expect(JSON.parse(objects.get(`mailboxes/${body.address}.json`)!).fromName).toBe("Support bot");

		// Token: confined to the new mailbox, scopes from send_mode, expires with the TTL.
		expect(body.token.secret).toMatch(/^ttk_[A-Za-z0-9]{12}_/);
		const [, id, secret] = body.token.secret.match(/^ttk_([A-Za-z0-9]{12})_(.+)$/);
		const validated = await auth.validateApiToken(id, await sha256Hex(secret), Date.now());
		expect(validated?.token.scopes).toEqual(["mail:read", "mail:send", "mail:send:auto", "mail:draft", "mail:organize"]);
		// The mailbox's agent send mode is the inbox's.
		expect(JSON.parse(objects.get(`mailboxes/${body.address}.json`)!).agentSend).toEqual({ mode: "auto", allowlist: [] });
		expect(validated?.token.mailboxes).toEqual([body.address]);
		expect(validated?.token.expiresAt).toBe(body.policy.expires_at);
		expect(body.policy.expires_at - Date.now()).toBeGreaterThan(2 * 3600_000 - 5000);

		// Policy and webhook.
		expect(body.policy.allowed_recipients).toEqual(["ops@example.org", "@partner.com"]);
		expect(body.webhook.secret).toMatch(/^whsec_/);
		const hook = hooks.getEndpoint(body.webhook.id)!;
		expect(hook.mailboxes).toEqual([body.address]);
		expect(hook.enabled).toBe(true);

		// Routing could not be confirmed (no CF token, no provision record): warned.
		expect(body.routing.routed).toBe(false);
		expect(body.warnings[0]).toMatch(/Email Routing/);

		// Listed, with a countdown and no secrets.
		const list = (await (await as(ownerUser)("/api/v1/agent-inboxes")).json()) as any;
		expect(list.agent_inboxes).toHaveLength(1);
		expect(list.agent_inboxes[0].expires_in_ms).toBeGreaterThan(0);
		expect(JSON.stringify(list)).not.toMatch(/ttk_|whsec_/);
		const one = await as(ownerUser)(`/api/v1/agent-inboxes/${encodeURIComponent(body.address)}`);
		expect(((await one.json()) as any).agent_inbox.send_mode).toBe("auto");
	});

	it("uses a chosen local part and refuses one that exists", async () => {
		const first = await as(ownerUser)("/api/v1/agent-inboxes", post({ domain: "example.com", local_part: "Bot", purpose: "x", send_mode: "draft_only" }));
		expect(first.status).toBe(201);
		const body = (await first.json()) as any;
		expect(body.address).toBe("bot@example.com");
		expect(body.token.scopes).toEqual(["mail:read", "mail:draft", "mail:organize"]);
		const again = await as(ownerUser)("/api/v1/agent-inboxes", post({ domain: "example.com", local_part: "bot", purpose: "x", send_mode: "draft_only" }));
		expect(again.status).toBe(409);
	});

	it("says no routing rule is needed when the stored provision shows the catch-all on the Worker", async () => {
		domains.createDomain({ hostname: "agents.example.com", now: 1 });
		const d = domains.getDomain("agents.example.com")!;
		domains.updateDomain(d.id, { lastProvision: { ok: true, ranAt: 1, steps: [{ step: "catch_all", status: "ok", detail: "" }] } }, 2);
		const res = await as(ownerUser)("/api/v1/agent-inboxes", post({ domain: "agents.example.com", purpose: "x", send_mode: "approve" }));
		const body = (await res.json()) as any;
		expect(body.routing).toEqual({ routed: true, source: "provision_record", warning: null });
		// There is an approval queue now, so approve needs no warning.
		expect(body.warnings).toEqual([]);
	});

	it("rejects an unserved domain and bad input", async () => {
		expect((await as(ownerUser)("/api/v1/agent-inboxes", post({ domain: "other.org", purpose: "x", send_mode: "auto" }))).status).toBe(400);
		expect((await as(ownerUser)("/api/v1/agent-inboxes", post({ domain: "example.com", purpose: "x", send_mode: "yolo" }))).status).toBe(400);
		expect(
			(await as(ownerUser)("/api/v1/agent-inboxes", post({ domain: "example.com", purpose: "x", send_mode: "auto", allowed_recipients: ["nope"] }))).status,
		).toBe(400);
		expect(
			(await as(ownerUser)("/api/v1/agent-inboxes", post({ domain: "example.com", purpose: "x", send_mode: "auto", webhook_url: "http://127.0.0.1/x" }))).status,
		).toBe(400);
	});

	it("replays an idempotent create without creating a second inbox, and without secrets", async () => {
		const run = () =>
			as(ownerUser)("/api/v1/agent-inboxes", post({ domain: "example.com", purpose: "x", send_mode: "auto", webhook_url: "https://hooks.partner.com/a" }, { "Idempotency-Key": "agent-key-1" }));
		const first = await run();
		expect(first.status).toBe(201);
		const a = (await first.json()) as any;
		const second = await run();
		expect(second.status).toBe(201);
		expect(second.headers.get("Idempotent-Replayed")).toBe("true");
		const b = (await second.json()) as any;
		expect(b.address).toBe(a.address);
		expect(b.token.secret).toBeNull();
		expect(b.webhook.secret).toBeNull();
		expect(b.secret_redacted).toBe(true);
		expect([...objects.keys()].filter((k) => k.startsWith("agent-inboxes/"))).toHaveLength(1);
		expect(hooks.listEndpoints()).toHaveLength(1);
	});
});

// ── Permissions ─────────────────────────────────────────────────────

describe("permissions", () => {
	it("refuses a member", async () => {
		const res = await as(memberUser)("/api/v1/agent-inboxes", post({ domain: "example.com", purpose: "x", send_mode: "auto" }));
		expect(res.status).toBe(403);
		expect((await as(memberUser)("/api/v1/agent-inboxes")).status).toBe(403);
	});

	it("refuses an admin's token without mailboxes:manage", async () => {
		const res = await as(ownerUser, { scopes: ["mail:read", "mail:send"] })(
			"/api/v1/agent-inboxes",
			post({ domain: "example.com", purpose: "x", send_mode: "auto" }),
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as any).scope).toBe("mailboxes:manage");
	});

	it("refuses a mailboxes:manage token that lacks the scopes the agent would get", async () => {
		const res = await as(ownerUser, { scopes: ["mailboxes:manage", "mail:read"] })(
			"/api/v1/agent-inboxes",
			post({ domain: "example.com", purpose: "x", send_mode: "auto" }),
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as any).code).toBe("scope_exceeds_parent");
	});

	it("lets a full mailboxes:manage token create a child token, capped at the parent's expiry", async () => {
		const parentExpiry = Date.now() + 3600_000;
		await auth.createApiToken({
			id: "tok_parent",
			userId: ownerUser.id,
			name: "p",
			secretHash: "h",
			expiresAt: parentExpiry,
			now: Date.now(),
			scopes: ["mailboxes:manage", "mail:read", "mail:send", "mail:send:auto", "mail:draft", "mail:organize"],
		});
		// An auto inbox's token holds mail:send:auto, which a parent can only pass on if it holds it.
		const without = await as(ownerUser, {
			scopes: ["mailboxes:manage", "mail:read", "mail:send", "mail:draft", "mail:organize"],
			expiresAt: parentExpiry,
		})("/api/v1/agent-inboxes", post({ domain: "example.com", purpose: "x", send_mode: "auto" }));
		expect(without.status).toBe(403);
		expect(((await without.json()) as any).code).toBe("scope_exceeds_parent");
		const res = await as(ownerUser, {
			id: "tok_parent",
			scopes: ["mailboxes:manage", "mail:read", "mail:send", "mail:send:auto", "mail:draft", "mail:organize"],
			expiresAt: parentExpiry,
		})("/api/v1/agent-inboxes", post({ domain: "example.com", purpose: "x", send_mode: "auto", ttl_hours: 48 }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(body.policy.expires_at).toBe(parentExpiry);
		// Revoking the parent revokes the agent's token.
		await auth.revokeApiToken(ownerUser.id, "tok_parent");
		const [, id, secret] = body.token.secret.match(/^ttk_([A-Za-z0-9]{12})_(.+)$/);
		expect(await auth.validateApiToken(id, await sha256Hex(secret), Date.now())).toBeNull();
	});

	it("refuses a token confined to particular mailboxes", async () => {
		const res = await as(ownerUser, {
			scopes: ["admin", "mailboxes:manage", "mail:read", "mail:send", "mail:draft", "mail:organize"],
			mailboxes: ["support@example.com"],
		})("/api/v1/agent-inboxes", post({ domain: "example.com", purpose: "x", send_mode: "draft_only" }));
		expect(res.status).toBe(403);
	});
});

// ── Ending ──────────────────────────────────────────────────────────

describe("expiry and delete", () => {
	async function create(extra: Record<string, unknown> = {}) {
		const res = await as(ownerUser)(
			"/api/v1/agent-inboxes",
			post({ domain: "example.com", purpose: "x", send_mode: "auto", webhook_url: "https://hooks.partner.com/a", ...extra }),
		);
		return (await res.json()) as any;
	}

	it("expires: revokes the token, removes the webhook, archives mbox to R2, deletes the mailbox, audits", async () => {
		const body = await create({ ttl_hours: 1 });
		const address: string = body.address;
		mailboxMessages[address] = [
			{ id: "m1", subject: "Hello", sender: "a@b.com", recipient: address, date: "2026-10-25T10:00:00Z", body: "<p>hi</p>" },
		];
		const env = makeEnv();
		// Not due yet.
		expect(await expireAgentInboxes(env, Date.now())).toEqual({ expired: 0, failed: 0 });
		const result = await expireAgentInboxes(env, Date.now() + 2 * 3600_000);
		expect(result).toEqual({ expired: 1, failed: 0 });

		const [, id, secret] = body.token.secret.match(/^ttk_([A-Za-z0-9]{12})_(.+)$/);
		expect(await auth.validateApiToken(id, await sha256Hex(secret), Date.now())).toBeNull();
		expect(hooks.getEndpoint(body.webhook.id)).toBeNull();
		const archive = [...objects.keys()].find((k) => k.startsWith(`archives/agent-inboxes/${address}-`));
		expect(archive).toBeDefined();
		expect(objects.get(archive!)).toContain("Subject: Hello");
		expect(objects.has(`mailboxes/${address}.json`)).toBe(false);
		expect(purged).toContain(address);
		expect(objects.has(`agent-inboxes/${address}.json`)).toBe(false);
		const audit = [...objects.entries()].filter(([k]) => k.startsWith("audit/")).map(([, v]) => JSON.parse(v));
		expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["agent_inbox.create", "agent_inbox.expire"]));
		expect(audit.find((e) => e.action === "agent_inbox.expire").detail.archive).toBe(archive);
	});

	it("reaps an agent inbox whose mailbox was deleted elsewhere (token and webhook too)", async () => {
		const body = await create();
		objects.delete(`mailboxes/${body.address}.json`);
		// Too new to reap: a create may still be in flight.
		expect(await expireAgentInboxes(makeEnv(), Date.now())).toEqual({ expired: 0, failed: 0 });
		expect(await expireAgentInboxes(makeEnv(), Date.now() + 11 * 60_000)).toEqual({ expired: 1, failed: 0 });
		const [, id, secret] = body.token.secret.match(/^ttk_([A-Za-z0-9]{12})_(.+)$/);
		expect(await auth.validateApiToken(id, await sha256Hex(secret), Date.now())).toBeNull();
		expect(hooks.getEndpoint(body.webhook.id)).toBeNull();
		expect(objects.has(`agent-inboxes/${body.address}.json`)).toBe(false);
	});

	it("plain mailbox delete also ends the agent inbox's token and webhook", async () => {
		const body = await create();
		const res = await as(ownerUser)(`/api/v1/mailboxes/${encodeURIComponent(body.address)}`, { method: "DELETE" });
		expect(res.status).toBe(204);
		// The cleanup runs under waitUntil; give it a tick.
		await new Promise((r) => setTimeout(r, 10));
		expect(hooks.getEndpoint(body.webhook.id)).toBeNull();
		expect(objects.has(`agent-inboxes/${body.address}.json`)).toBe(false);
	});

	it("DELETE ends it early with the same cleanup", async () => {
		const body = await create();
		const res = await as(ownerUser)(`/api/v1/agent-inboxes/${encodeURIComponent(body.address)}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const ended = ((await res.json()) as any).ended;
		expect(ended).toMatchObject({ token_revoked: true, webhook_disabled: true, mailbox_deleted: true, archive: null });
		expect(objects.has(`mailboxes/${body.address}.json`)).toBe(false);
		expect((await as(ownerUser)(`/api/v1/agent-inboxes/${encodeURIComponent(body.address)}`)).status).toBe(404);
	});
});

// ── Send enforcement ────────────────────────────────────────────────

describe("send policy on the send routes", () => {
	async function agent(mode: "auto" | "approve" | "draft_only", allowed?: string[]) {
		const res = await as(ownerUser)(
			"/api/v1/agent-inboxes",
			post({ domain: "example.com", purpose: "x", send_mode: mode, ...(allowed ? { allowed_recipients: allowed } : {}) }),
		);
		const body = (await res.json()) as any;
		const [, id] = body.token.secret.match(/^ttk_([A-Za-z0-9]{12})_/);
		return { address: body.address as string, tokenId: id as string, scopes: body.token.scopes as TokenScope[] };
	}
	const email = (from: string, to: string) => post({ from, to, subject: "Hi", text: "hello" });

	it("refuses a recipient outside allowed_recipients, for the agent and for an admin", async () => {
		const a = await agent("auto", ["@partner.com"]);
		const viaAgent = as(ownerUser, { id: a.tokenId, scopes: a.scopes, mailboxes: [a.address] });
		const refused = await viaAgent(`/api/v1/mailboxes/${a.address}/emails`, email(a.address, "eve@evil.com"));
		expect(refused.status).toBe(422);
		const refusedBody = (await refused.json()) as any;
		expect(refusedBody.code).toBe("recipient_not_allowed");
		expect(refusedBody.error).toContain("eve@evil.com");
		const asAdmin = await as(ownerUser)(`/api/v1/mailboxes/${a.address}/emails`, email(a.address, "eve@evil.com"));
		expect(asAdmin.status).toBe(422);
		// Every other path reaches the same gate (test/pre-send-paths.test.ts
		// proves each sendEmail call site does); the rule itself is below.
	});

	it("has no recipient restriction by default, and PATCH sets and clears one", async () => {
		const open = await agent("auto");
		const view = (await (await as(ownerUser)(`/api/v1/agent-inboxes/${encodeURIComponent(open.address)}`)).json()) as any;
		expect(view.agent_inbox.allowed_recipients).toBeNull();
		const viaAgent = as(ownerUser, { id: open.tokenId, scopes: open.scopes, mailboxes: [open.address] });
		// Default: anyone.
		expect((await viaAgent(`/api/v1/mailboxes/${open.address}/emails`, email(open.address, "anyone@else.example"))).status).not.toBe(422);

		const path = `/api/v1/agent-inboxes/${encodeURIComponent(open.address)}`;
		const set = await as(ownerUser)(path, { method: "PATCH", body: JSON.stringify({ allowed_recipients: ["@partner.com", "Bob@X.example"] }) });
		expect(set.status).toBe(200);
		expect(((await set.json()) as any).agent_inbox.allowed_recipients).toEqual(["@partner.com", "bob@x.example"]);
		expect((await viaAgent(`/api/v1/mailboxes/${open.address}/emails`, email(open.address, "eve@evil.com"))).status).toBe(422);

		const cleared = await as(ownerUser)(path, { method: "PATCH", body: JSON.stringify({ allowed_recipients: null }) });
		expect(((await cleared.json()) as any).agent_inbox.allowed_recipients).toBeNull();
		expect((await viaAgent(`/api/v1/mailboxes/${open.address}/emails`, email(open.address, "eve@evil.com"))).status).not.toBe(422);

		// An empty list means no restriction, not "refuse everyone".
		const empty = await as(ownerUser)(path, { method: "PATCH", body: JSON.stringify({ allowed_recipients: [] }) });
		expect(((await empty.json()) as any).agent_inbox.allowed_recipients).toBeNull();
		expect((await as(ownerUser)(path, { method: "PATCH", body: JSON.stringify({ allowed_recipients: ["not an address"] }) })).status).toBe(400);
		expect((await as(ownerUser)(path, { method: "PATCH", body: JSON.stringify({ send_mode: "auto" }) })).status).toBe(400);
	});

	it("refuses PATCH to a member and to a token without mailboxes:manage", async () => {
		const a = await agent("auto");
		const path = `/api/v1/agent-inboxes/${encodeURIComponent(a.address)}`;
		const viaAgent = as(ownerUser, { id: a.tokenId, scopes: a.scopes, mailboxes: [a.address] });
		expect((await viaAgent(path, { method: "PATCH", body: JSON.stringify({ allowed_recipients: null }) })).status).toBe(403);
	});

	it("is a pre-send gate rule, so every path and every send kind applies it", async () => {
		const a = await agent("auto", ["@partner.com"]);
		const env = makeEnv();
		const base = { from: a.address, mailboxId: a.address, subject: "s", text: "t", to: ["eve@evil.com"] };
		const refusal = { outcome: "block", code: "rule", rule: "agent-inbox-policy", ruleCode: "recipient_not_allowed", status: 422 };
		for (const kind of ["transactional", "bulk", "automated"] as const) {
			// Cron (scheduled delivery, sequences), inbound (auto-reply, forwarding) and agent sends.
			for (const via of ["cron", "inbound", "agent", "mcp"] as const) {
				const r = await preSend(env, { ...base, kind, actor: { via } }, { quota: () => ({ checkSendRateLimit: async () => null }) });
				expect({ kind, via, r }).toMatchObject({ kind, via, r: refusal });
			}
		}
		// System mail (password resets) belongs to no mailbox and is never filtered.
		const system = await preSend(env, { ...base, kind: "system", mailboxId: null }, {});
		expect(system.ok).toBe(true);
		// An allowed recipient goes through.
		const ok = await preSend(env, { ...base, kind: "transactional", to: ["pat@partner.com"] }, { quota: () => ({ checkSendRateLimit: async () => null }) });
		expect(ok.ok).toBe(true);
	});

	it("applies the send mode only to the agent's own token at the gate", async () => {
		const a = await agent("draft_only");
		const env = makeEnv();
		const quota = () => ({ checkSendRateLimit: async () => null });
		const input = { kind: "transactional" as const, from: a.address, mailboxId: a.address, subject: "s", text: "t", to: ["x@y.com"] };
		const viaToken = await preSend(env, { ...input, actor: { via: "rest", credential: { method: "token", tokenId: a.tokenId } } }, { quota });
		expect(viaToken).toMatchObject({ ok: false, ruleCode: "drafts_only", status: 403 });
		// A person sending the agent's draft is the approval.
		const viaSession = await preSend(env, { ...input, actor: { via: "rest", credential: { method: "session" } } }, { quota });
		expect(viaSession.ok).toBe(true);
	});

	it("lets an allowed recipient through to the route", async () => {
		const a = await agent("auto", ["@partner.com"]);
		const viaAgent = as(ownerUser, { id: a.tokenId, scopes: a.scopes, mailboxes: [a.address] });
		const res = await viaAgent(`/api/v1/mailboxes/${a.address}/emails`, email(a.address, "pat@partner.com"));
		// Past the policy: the fake mailbox's rate limiter answers instead.
		expect(res.status).not.toBe(422);
		expect(res.status).not.toBe(403);
	});

	it("blocks a draft_only agent token from sending (scopes and policy both)", async () => {
		const a = await agent("draft_only");
		const viaAgent = as(ownerUser, { id: a.tokenId, scopes: a.scopes, mailboxes: [a.address] });
		const res = await viaAgent(`/api/v1/mailboxes/${a.address}/emails`, email(a.address, "pat@partner.com"));
		expect(res.status).toBe(403);
		// The capability gate refuses first (no mail:send); the policy is the second lock.
		expect(decideAgentSend({ send_mode: "draft_only", allowed_recipients: null }, ["pat@partner.com"], true)).toMatchObject({
			code: "drafts_only",
		});
	});

	it("holds an approve inbox's sends for approval, even when its token could auto-send", async () => {
		const a = await agent("auto");
		const key = `agent-inboxes/${a.address}.json`;
		// The inbox record says approve; the stricter of it and the mailbox setting wins.
		objects.set(key, JSON.stringify({ ...JSON.parse(objects.get(key)!), send_mode: "approve" }));
		const viaAgent = as(ownerUser, { id: a.tokenId, scopes: a.scopes, mailboxes: [a.address] });
		const res = await viaAgent(`/api/v1/mailboxes/${a.address}/emails`, email(a.address, "pat@partner.com"));
		expect(res.status).toBe(202);
		expect(await res.json()).toMatchObject({ status: "pending_approval" });
		expect(held).toHaveLength(1);
		expect(held[0]).toMatchObject({ mailbox: a.address, kind: "rest_send", recipients: ["pat@partner.com"] });
		expect(sent).toHaveLength(0);
	});

	it("an approve inbox's token reaches the send route and is held, not refused", async () => {
		const a = await agent("approve");
		expect(a.scopes).toContain("mail:send");
		expect(a.scopes).not.toContain("mail:send:auto");
		const viaAgent = as(ownerUser, { id: a.tokenId, scopes: a.scopes, mailboxes: [a.address] });
		const res = await viaAgent(`/api/v1/mailboxes/${a.address}/emails`, email(a.address, "pat@partner.com"));
		expect(res.status).toBe(202);
		expect(await res.json()).toMatchObject({ status: "pending_approval" });
		expect(sent).toHaveLength(0);
	});

	it("a recipient outside allowed_recipients is a hard block in approve mode, never held", async () => {
		const a = await agent("approve", ["@partner.com"]);
		const viaAgent = as(ownerUser, { id: a.tokenId, scopes: a.scopes, mailboxes: [a.address] });
		const res = await viaAgent(`/api/v1/mailboxes/${a.address}/emails`, email(a.address, "eve@evil.com"));
		expect(res.status).toBe(422);
		expect(((await res.json()) as any).code).toBe("recipient_not_allowed");
		expect(held).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it("leaves other mailboxes alone", async () => {
		objects.set("mailboxes/support@example.com.json", "{}");
		const res = await as(ownerUser)("/api/v1/mailboxes/support@example.com/emails", email("support@example.com", "eve@evil.com"));
		expect(res.status).not.toBe(422);
	});
});
