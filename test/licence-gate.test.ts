/**
 * The app licence ("paid for everything"): workers/lib/licence.ts,
 * licence-store.ts, licence-gate.ts, routes/licence.ts and the places the
 * lock reaches (pre-send, scheduled sends, sequences, webhooks, inbound).
 *
 * The licence server is mocked with a fake fetch. Tokens are signed here with
 * a throwaway Ed25519 key generated per run; the bundled development key's
 * private half is never in the repository.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_MIGRATION_NAMES, AuthStore, type AuthSql } from "../workers/auth/store-core";
import { LicenceStore } from "../workers/lib/licence-store";
import {
	activateLicence,
	decideLicence,
	enforcementMode,
	invalidateLicenceCache,
	licenceState,
	licenceView,
	maybeRefreshLicence,
	refreshLicence,
	type LicenceDeps,
	type LicenceRpc,
} from "../workers/lib/licence";
import { isLicenceExempt, licenceGate } from "../workers/lib/licence-gate";
import { preSend } from "../workers/lib/pre-send";
import { DEV_KEY_ID, LICENCE_KEYS, PRODUCTION_KEY_ID, onlyDevKey, verificationJwks } from "../shared/licence-keys";
import { base64UrlEncode, type Ed25519PublicJwk, type Jwks, type LicenceClaims } from "../shared/licence-token";
import type { Env } from "../workers/types";
// @ts-expect-error plain .mjs script without type declarations
import { parseJsonc, rewriteWrangler } from "../scripts/build-template.mjs";

const ROOT = join(__dirname, "..");
const HOST = "mail.customer.example";
const DAY = 86_400;

// ── signing (test-only key) ────────────────────────────────────────

let signingKey: CryptoKey;
let jwks: Jwks;
const KID = "test-1";

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	signingKey = pair.privateKey;
	const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
	jwks = { keys: [{ kty: "OKP", crv: "Ed25519", x: pub.x!, kid: KID, alg: "EdDSA", use: "sig" }] };
});

async function mint(claims: Partial<LicenceClaims> & { deployment_id: string }, now: number): Promise<string> {
	const full: LicenceClaims = {
		iss: "https://tapetide.com",
		aud: "tapetide-mail",
		v: 1,
		licence_id: "tlc_test",
		customer: { id: "cus_test", email: "buyer@example.org" },
		plan: "one-time",
		instances: 2,
		bind: { host: HOST, cf_account: null },
		features: [],
		sub_status: "none",
		iat: now,
		nbf: now,
		exp: now + 30 * DAY,
		...claims,
	};
	const enc = new TextEncoder();
	const h = base64UrlEncode(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "tapetide-lic+jwt", kid: KID })));
	const p = base64UrlEncode(enc.encode(JSON.stringify(full)));
	const sig = await crypto.subtle.sign({ name: "Ed25519" }, signingKey, enc.encode(`${h}.${p}`));
	return `${h}.${p}.${base64UrlEncode(sig)}`;
}

// ── storage on real SQLite ─────────────────────────────────────────

function adapter(db: DatabaseSync): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				// Eager, like SqlStorage: a statement runs whether or not rows are read.
				const rows = db.prepare(query).all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx: <T>(fn: () => T) => fn(),
	};
}

let db: DatabaseSync;
let store: LicenceStore;
let clock: number;
let rpc: LicenceRpc;
let env: Env;

function makeRpc(s: LicenceStore): LicenceRpc {
	return {
		getLicence: async () => s.get(clock, () => `dep_${crypto.randomUUID()}`),
		storeLicenceToken: async (token, refreshAfter) => {
			s.get(clock, () => `dep_${crypto.randomUUID()}`);
			return s.storeToken(token, refreshAfter, clock);
		},
		recordLicenceFailure: async (status, reason) => s.recordFailure(clock, status, reason),
		clearLicenceToken: async () => s.clearToken(clock),
		claimLicenceRefresh: async (min) => s.claimRefresh(clock, min),
	};
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	new AuthStore(sql, tx);
	store = new LicenceStore(sql, tx);
	clock = 1_800_000_000;
	rpc = makeRpc(store);
	env = { LICENCE_ENFORCEMENT: "enforce", APP_URL: `https://${HOST}`, AUTH_STORE: {} } as unknown as Env;
	invalidateLicenceCache(env);
	vi.restoreAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

const deps = (extra: Partial<LicenceDeps> = {}): LicenceDeps => ({ rpc, jwks, now: () => clock, ...extra });

async function storeValid(claims: Partial<LicenceClaims> = {}): Promise<string> {
	const rec = await rpc.getLicence();
	const token = await mint({ deployment_id: rec.deploymentId, ...claims }, clock);
	await rpc.storeLicenceToken(token, clock + DAY);
	return token;
}

/** A licence server double. Records every request body it sees. */
function fakeServer(handler: (path: string, body: any) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
	const calls: { path: string; body: any }[] = [];
	const f = (async (url: string, init: RequestInit) => {
		const path = new URL(url).pathname;
		const body = JSON.parse(String(init.body));
		calls.push({ path, body });
		const r = await handler(path, body);
		return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetch: f, calls };
}

// ── migration and deployment id ────────────────────────────────────

describe("state", () => {
	it("0025_licence is appended after PR 1's 0024_deployment_origin", () => {
		expect(AUTH_MIGRATION_NAMES.at(-1)).toBe("0025_licence");
		expect(AUTH_MIGRATION_NAMES.at(-2)).toBe("0024_deployment_origin");
	});

	it("deployment_id is generated once and stays stable", async () => {
		const a = (await rpc.getLicence()).deploymentId;
		const b = (await rpc.getLicence()).deploymentId;
		await storeValid();
		await rpc.clearLicenceToken();
		const c = (await rpc.getLicence()).deploymentId;
		expect(a).toMatch(/^dep_[0-9a-f-]{36}$/);
		expect(b).toBe(a);
		expect(c).toBe(a);
	});
});

// ── the gate states ────────────────────────────────────────────────

describe("gate states", () => {
	it("off: never locks and never reads storage", async () => {
		const offEnv = { LICENCE_ENFORCEMENT: "off" } as unknown as Env;
		expect(enforcementMode(offEnv)).toBe("off");
		expect(enforcementMode({} as Env)).toBe("off");
		expect(enforcementMode({ LICENCE_ENFORCEMENT: "Enforce " } as unknown as Env)).toBe("enforce");
		const s = await licenceState(offEnv);
		expect(s).toMatchObject({ status: "off", locked: false });
	});

	it("no token: locked", async () => {
		const s = await licenceState(env, deps());
		expect(s).toMatchObject({ status: "none", locked: true });
	});

	it("valid token: active", async () => {
		await storeValid();
		expect(await licenceState(env, deps())).toMatchObject({ status: "active", locked: false });
	});

	it("grace (past exp, within 7 days): not locked, with days left", async () => {
		await storeValid();
		clock += 30 * DAY + 2 * DAY;
		invalidateLicenceCache(env);
		const s = await licenceState(env, deps());
		expect(s).toMatchObject({ status: "grace", locked: false });
		expect(licenceView(s, clock).graceDaysLeft).toBe(5);
	});

	it("expired past grace: locked", async () => {
		await storeValid();
		clock += 30 * DAY + 8 * DAY;
		invalidateLicenceCache(env);
		expect(await licenceState(env, deps())).toMatchObject({ status: "expired", locked: true });
	});

	it("invalid: another deployment, another host, an unknown key, a forged signature", async () => {
		const rec = await rpc.getLicence();
		const cases = [
			await mint({ deployment_id: "dep_someone_else" }, clock),
			await mint({ deployment_id: rec.deploymentId, bind: { host: "other.example", cf_account: null } }, clock),
		];
		const forged = (await mint({ deployment_id: rec.deploymentId }, clock)).replace(/\.[^.]+$/, `.${"A".repeat(86)}`);
		cases.push(forged);
		for (const token of cases) {
			await rpc.storeLicenceToken(token, null);
			const s = await decideLicence(env, await rpc.getLicence(), deps());
			expect(s.status, token.slice(-8)).toBe("invalid");
			expect(s.locked).toBe(true);
		}
		await storeValid();
		const other = await decideLicence(env, await rpc.getLicence(), deps({ jwks: { keys: [] } }));
		expect(other).toMatchObject({ status: "invalid", locked: true });
	});

	it("revoked by the server: locked even while the token is unexpired", async () => {
		await storeValid();
		await rpc.recordLicenceFailure("revoked", "refund");
		expect(await decideLicence(env, await rpc.getLicence(), deps())).toMatchObject({ status: "revoked", locked: true });
	});

	it("payment_required (defensive; one-time licences) locks as expired", async () => {
		await storeValid();
		await rpc.recordLicenceFailure("payment_required", null);
		expect(await decideLicence(env, await rpc.getLicence(), deps())).toMatchObject({ status: "expired", locked: true });
	});

	it("unreadable licence state fails closed for the API and for sends", async () => {
		const broken: LicenceRpc = { ...rpc, getLicence: async () => { throw new Error("down"); } };
		await expect(licenceState(env, { rpc: broken, jwks })).rejects.toThrow(/unavailable/);
		const gate = await preSend(env, { kind: "transactional", from: "a@x.example", mailboxId: null, to: "b@y.example", text: "hi" }, { licence: { rpc: broken, jwks } });
		expect(gate).toMatchObject({ ok: false, code: "licence_unavailable", status: 503 });
	});
});

// ── the API gate and its exemptions ────────────────────────────────

describe("API gate", () => {
	it("exempts sign-in, the licence routes, /me (GET only), the Cloudflare connection and public reads", () => {
		for (const [m, p] of [
			["POST", "/api/auth/login"],
			["POST", "/api/auth/logout"],
			["POST", "/api/auth/setup"],
			["POST", "/api/auth/password/forgot"],
			["POST", "/api/auth/passkeys/reauth"],
			["GET", "/api/auth/sessions"],
			["GET", "/api/auth/state"],
			["GET", "/api/v1/licence"],
			["POST", "/api/v1/licence/activate"],
			["POST", "/api/v1/licence/deactivate"],
			["GET", "/api/v1/me"],
			["GET", "/api/v1/cloudflare/connection"],
			["PUT", "/api/v1/cloudflare/connection"],
			["GET", "/api/v1/branding"],
			["GET", "/api/v1/openapi.json"],
			// Pages and assets: no data; the shell shows the activate screen.
			["GET", "/"],
			["GET", "/settings/licence"],
			["GET", "/assets/app.js"],
		]) {
			expect(isLicenceExempt(m, p), `${m} ${p}`).toBe(true);
		}
	});

	it("gates everything else on /api, /mcp and /agents", () => {
		for (const [m, p] of [
			["GET", "/api/v1/mailboxes"],
			["POST", "/api/v1/mailboxes/a@x.example/emails"],
			["PATCH", "/api/v1/me"],
			["GET", "/api/v1/me/brief"],
			["PUT", "/api/v1/branding"],
			["POST", "/api/v1/cloudflare/apply"],
			["POST", "/mcp"],
			["GET", "/agents/email-agent/a@x.example"],
			["GET", "/api/v1/licence-something"],
			// Account administration and API tokens are app features, not sign-in.
			["GET", "/api/auth/admin/users"],
			["POST", "/api/auth/admin/invites"],
			["GET", "/api/auth/tokens"],
			["POST", "/api/auth/tokens"],
			["GET", "/api/auth/oauth-grants"],
		]) {
			expect(isLicenceExempt(m, p), `${m} ${p}`).toBe(false);
		}
	});

	function gatedApp(e: Env) {
		const app = new Hono<any>();
		app.use("*", licenceGate);
		app.all("*", (c) => c.json({ ok: true }));
		const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
		return (method: string, path: string) => app.fetch(new Request(`https://${HOST}${path}`, { method }), e, ctx);
	}

	it("answers 402 licence_required while locked, and passes once active", async () => {
		const e = { ...env, AUTH_STORE: { idFromName: () => "g", get: () => rpc } } as unknown as Env;
		invalidateLicenceCache(e);
		const call = gatedApp(e);
		const res = await call("GET", "/api/v1/mailboxes");
		expect(res.status).toBe(402);
		expect(await res.json()).toMatchObject({ code: "licence_required" });
		expect((await call("POST", "/mcp")).status).toBe(402);
		expect((await call("GET", "/api/v1/licence")).status).toBe(200);
		expect((await call("GET", "/u/sometoken")).status).toBe(200);
	});

	it("is a no-op with enforcement off", async () => {
		const call = gatedApp({ LICENCE_ENFORCEMENT: "off" } as unknown as Env);
		expect((await call("GET", "/api/v1/mailboxes")).status).toBe(200);
	});

	it("is mounted after the auth gate, with the recipient endpoints before it", () => {
		const app = readFileSync(join(ROOT, "workers/app.ts"), "utf8");
		const gate = app.indexOf('app.use("*", licenceGate);');
		expect(gate).toBeGreaterThan(app.indexOf('app.use("*", createAuthGate(authDeps));'));
		for (const route of ['app.get("/t/o/:token"', 'app.get("/t/c/:token"', 'app.get("/u/:token"', 'app.post("/u/:token"', 'app.get("/privacy"', "app.route(\"/\", publicProductRoutes)", "app.route(\"/\", publicPushRoutes)", 'app.get("/img/:sig"']) {
			const at = app.indexOf(route);
			expect(at, route).toBeGreaterThan(-1);
			expect(at, route).toBeLessThan(gate);
		}
		// MCP and the API app come after it.
		expect(app.indexOf('app.all("/mcp", serveMcp)')).toBeGreaterThan(gate);
		expect(app.indexOf('app.route("/", apiApp)')).toBeGreaterThan(gate);
	});
});

// ── sends are locked ───────────────────────────────────────────────

describe("outbound sends while locked", () => {
	const input = { kind: "transactional" as const, from: "a@x.example", mailboxId: null, to: "b@y.example", text: "hi" };

	it("preSend refuses every kind with 402 licence_required", async () => {
		for (const kind of ["transactional", "bulk", "automated", "system"] as const) {
			const gate = await preSend(env, { ...input, kind }, { licence: deps() });
			expect(gate, kind).toMatchObject({ ok: false, code: "licence_required", status: 402 });
		}
	});

	it("except the password reset, so an admin can get in to activate", async () => {
		const gate = await preSend(env, { ...input, kind: "system", licenceExempt: true }, { licence: deps() });
		expect(gate.ok).toBe(true);
		const reset = readFileSync(join(ROOT, "workers/auth/reset-email.ts"), "utf8");
		expect(reset).toMatch(/licenceExempt: true/);
		const others = ["workers", "shared"].flatMap((d) =>
			execGrep(join(ROOT, d), "licenceExempt: true").filter((f) => !f.endsWith("auth/reset-email.ts")),
		);
		expect(others).toEqual([]);
	});

	it("allows sends once active", async () => {
		await storeValid();
		const gate = await preSend(env, input, { licence: deps(), suppressions: { findSuppressions: async () => [] } });
		expect(gate.ok).toBe(true);
	});
});

function execGrep(dir: string, needle: string): string[] {
	const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...execGrep(p, needle));
		else if (/\.tsx?$/.test(name) && readFileSync(p, "utf8").includes(needle)) out.push(p);
	}
	return out;
}

// ── scheduled sends held, not dropped ──────────────────────────────

describe("scheduled sends while locked", () => {
	it("are held without spending attempts, and go out after activation", async () => {
		const { applyMigrations, mailboxMigrations } = await import("../workers/durableObject/migrations");
		const { processDueScheduledSends, recordScheduledSend } = await import("../workers/durableObject/features");
		const mdb = new DatabaseSync(":memory:");
		const exec = (q: string, ...b: unknown[]) => {
			const t = q.trim();
			if (b.length === 0 && !/^(select|with)/i.test(t)) {
				mdb.exec(t);
				return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
			}
			const rows = mdb.prepare(t).all(...(b as never[])) as any[];
			return { toArray: () => rows, rowsWritten: 1, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		};
		const ctx = {
			id: { name: "a@x.example" },
			storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => {} },
		} as unknown as DurableObjectState;
		applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
		mdb.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read) VALUES ('m1', 'scheduled', 'Hi', 'a@x.example', 'b@y.example', '2026-10-26T09:00:00.000Z', '<p>Hi</p>', 1)`,
		).run();
		recordScheduledSend(ctx, "m1", "2026-10-26T09:00:00.000Z", { trackingBaseUrl: null, mailboxId: "a@x.example" });
		const sent: unknown[] = [];
		const mEnv = { EMAIL: { send: async (m: unknown) => (sent.push(m), { messageId: "p1" }) }, BUCKET: { get: async () => null } } as unknown as Env;

		let locked = true;
		for (let i = 0; i < 12; i++) {
			await processDueScheduledSends(ctx, mEnv, { now: new Date(Date.parse("2026-10-26T09:05:00.000Z") + i * 3600_000), licenceLocked: async () => locked });
		}
		const held = mdb.prepare(`SELECT status, attempts, send_at FROM scheduled_sends WHERE email_id = 'm1'`).get() as any;
		expect(sent).toHaveLength(0);
		expect(held.status).toBe("pending");
		expect(held.attempts).toBe(0);
		expect((mdb.prepare(`SELECT folder_id FROM emails WHERE id = 'm1'`).get() as any).folder_id).toBe("scheduled");

		locked = false;
		await processDueScheduledSends(ctx, mEnv, { now: new Date("2026-10-27T12:00:00.000Z"), licenceLocked: async () => locked });
		expect(sent).toHaveLength(1);
	});
});

// ── sequences and webhooks pause ───────────────────────────────────

describe("background work while locked", () => {
	it("the sequence cron reads nothing and sends nothing", async () => {
		const { dispatchDueSequenceEmails } = await import("../workers/lib/sequence-dispatch");
		const bucket = { get: vi.fn(async () => null), list: vi.fn(async () => ({ objects: [], truncated: false })) };
		const e = { ...env, BUCKET: bucket, AUTH_STORE: { idFromName: () => "g", get: () => rpc } } as unknown as Env;
		invalidateLicenceCache(e);
		expect(await dispatchDueSequenceEmails(e)).toEqual({ sent: 0, skipped: 0, suppressed: 0, failed: 0 });
		expect(bucket.list).not.toHaveBeenCalled();
	});

	it("webhook drain claims nothing and parks the alarm (no busy loop)", () => {
		const src = readFileSync(join(ROOT, "workers/lib/webhooks-do.ts"), "utf8");
		const drain = src.slice(src.indexOf("private async drain()"), src.indexOf("private async rearm()"));
		const guard = drain.indexOf("backgroundLocked(this.env)");
		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(drain.indexOf("claimDue"));
		expect(drain.slice(guard, drain.indexOf("try {"))).toMatch(/setAlarm\(Date\.now\(\) \+ LICENCE_PAUSE_MS\)[\s\S]*return;/);
		const sendNow = src.slice(src.indexOf("private async sendNow("), src.indexOf("private async drain()"));
		expect(sendNow.indexOf("backgroundLocked")).toBeLessThan(sendNow.indexOf("claimOne"));
	});

	it("an agent socket opened before the lock refuses the next turn; auto-draft and follow-ups idle", () => {
		const src = readFileSync(join(ROOT, "workers/agent/index.ts"), "utf8");
		const turn = src.slice(src.indexOf("async onChatMessage("));
		expect(turn.indexOf("backgroundLocked(env)")).toBeLessThan(turn.indexOf("createEmailTools("));
		expect(src).toMatch(/\/onNewEmail" \|\| url\.pathname === "\/onFollowup"\) && \(await backgroundLocked/);
	});

	it("push notification actions (archive, mark read) are refused", () => {
		const src = readFileSync(join(ROOT, "workers/routes/push.ts"), "utf8");
		const action = src.slice(src.indexOf('publicPushRoutes.post("/push/action"'));
		expect(action.indexOf("backgroundLocked")).toBeLessThan(action.indexOf("performAction("));
	});
});

// ── inbound mail is always stored ──────────────────────────────────

describe("inbound mail while locked", () => {
	it("the email() handler stores the message and does nothing else", async () => {
		const { receiveEmail } = await import("../workers/index");
		const created: { folder: string; row: any }[] = [];
		const calls: string[] = [];
		const stub = new Proxy(
			{},
			{
				get: (_t, name: string) => {
					if (name === "then") return undefined;
					return async (...args: any[]) => {
						calls.push(name);
						if (name === "createEmail") created.push({ folder: args[0], row: args[1] });
						if (name === "isSenderBlocked" || name === "isSenderAllowed" || name === "hasMessageId" || name === "isThreadMuted") return false;
						if (name === "findThreadByMessageIds") return null;
						if (name === "applyRules") return null;
						return null;
					};
				},
			},
		);
		const sent: unknown[] = [];
		const agentFetch = vi.fn(async () => new Response("{}"));
		const e = {
			LICENCE_ENFORCEMENT: "enforce",
			DOMAINS: "x.example",
			EMAIL_ADDRESSES: [],
			EMAIL: { send: async (m: unknown) => (sent.push(m), { messageId: "p" }) },
			BUCKET: {
				head: async (k: string) => (k === "mailboxes/a@x.example.json" ? {} : null),
				get: async (k: string) =>
					k === "mailboxes/a@x.example.json"
						? { json: async () => ({ forwarding: { enabled: true, email: "fwd@else.example" }, autoReply: { enabled: true, message: "Away" }, autoDraft: { enabled: true } }) }
						: null,
				put: async () => {},
				list: async () => ({ objects: [], truncated: false }),
			},
			MAILBOX: { idFromName: (n: string) => n, get: () => stub },
			EMAIL_AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: agentFetch }) },
			// No licence row at all: locked.
			AUTH_STORE: { idFromName: () => "g", get: () => ({ ...rpc, listDomains: async () => [], routingLookup: async () => ({ aliases: {}, catchAll: {} }) }) },
		} as unknown as Env;
		invalidateLicenceCache(e);
		const raw = [
			"From: Sender <sender@else.example>",
			"To: a@x.example",
			"Subject: Hello",
			"Message-ID: <m1@else.example>",
			"Date: Mon, 26 Oct 2026 09:00:00 +0000",
			"Content-Type: text/plain",
			"",
			"Hello there",
		].join("\r\n");
		const bytes = new TextEncoder().encode(raw);
		const waits: Promise<unknown>[] = [];
		const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
		await receiveEmail({ raw: new Response(bytes).body!, rawSize: bytes.length, to: "a@x.example", from: "sender@else.example" }, e, ctx);
		await Promise.allSettled(waits);

		expect(created).toHaveLength(1);
		expect(created[0].folder).toBe("inbox");
		expect(created[0].row.subject).toBe("Hello");
		expect(sent).toEqual([]);
		expect(calls).not.toContain("enqueueTriage");
		expect(calls).not.toContain("emitReceivedWebhook");
		expect(calls).not.toContain("claimAutoReply");
		expect(calls).not.toContain("preparePush");
		expect(agentFetch).not.toHaveBeenCalled();
	});

	it("the email() handler itself never consults the licence", () => {
		const app = readFileSync(join(ROOT, "workers/app.ts"), "utf8");
		const handler = app.slice(app.indexOf("async email("));
		expect(handler).not.toMatch(/licen[cs]e/i);
		const index = readFileSync(join(ROOT, "workers/index.ts"), "utf8");
		const fn = index.slice(index.indexOf("async function receiveEmail("));
		// The only licence use is after the insert, via the never-throwing helper.
		expect(fn.indexOf("backgroundLocked(env)")).toBeGreaterThan(fn.indexOf("await stub.createEmail(targetFolder"));
		expect(fn.match(/licen[cs]e\w*\(/gi) ?? []).toEqual([]);
	});
});

// ── activation ─────────────────────────────────────────────────────

describe("activation", () => {
	const KEY = "LK-TEST-0000-1111-2222";

	it("success: stores the token, never the key", async () => {
		const server = fakeServer(async (path, body) => ({ status: 201, body: { token: await mint({ deployment_id: body.deployment_id, bind: { host: body.host, cf_account: null } }, clock), refresh_after: clock + DAY } }));
		const r = await activateLicence(env, { licenceKey: KEY, host: HOST, cfAccount: null, appVersion: null }, deps({ fetch: server.fetch }));
		expect(r.ok).toBe(true);
		expect(server.calls[0]).toMatchObject({ path: "/v1/licence/activate", body: { licence_key: KEY, host: HOST } });
		expect(server.calls[0].body.deployment_id).toBe((await rpc.getLicence()).deploymentId);
		const dump = JSON.stringify(db.prepare("SELECT * FROM licence").all()) + JSON.stringify(db.prepare("SELECT * FROM meta").all());
		expect(dump).not.toContain(KEY);
		expect(await licenceState(env, deps())).toMatchObject({ status: "active", locked: false });
	});

	it("failure: a bad key, the server down, a token this app can't verify", async () => {
		const bad = fakeServer(() => ({ status: 404, body: { error: "invalid_licence_key" } }));
		expect(await activateLicence(env, { licenceKey: KEY, host: HOST, cfAccount: null, appVersion: null }, deps({ fetch: bad.fetch }))).toMatchObject({ ok: false, status: 400, error: "invalid_licence_key" });

		const down = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
		expect(await activateLicence(env, { licenceKey: KEY, host: HOST, cfAccount: null, appVersion: null }, deps({ fetch: down }))).toMatchObject({ ok: false, status: 502, error: "unreachable" });

		const wrong = fakeServer(async () => ({ status: 201, body: { token: await mint({ deployment_id: "dep_other" }, clock), refresh_after: null } }));
		expect(await activateLicence(env, { licenceKey: KEY, host: HOST, cfAccount: null, appVersion: null }, deps({ fetch: wrong.fetch }))).toMatchObject({ ok: false, error: "bad_token" });
		expect((await rpc.getLicence()).token).toBeNull();
	});

	it("limit reached: 422 with a clear message", async () => {
		const full = fakeServer(() => ({ status: 409, body: { error: "activation_limit_reached" } }));
		const r = await activateLicence(env, { licenceKey: KEY, host: HOST, cfAccount: null, appVersion: null }, deps({ fetch: full.fetch }));
		expect(r).toMatchObject({ ok: false, status: 422, error: "activation_limit_reached" });
		if (!r.ok) expect(r.message).toMatch(/maximum number of deployments/);
	});

	it("the key never reaches a log line", async () => {
		const logged: string[] = [];
		for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
		const bad = fakeServer(() => ({ status: 500, body: { error: "upstream_error" } }));
		await activateLicence(env, { licenceKey: KEY, host: HOST, cfAccount: null, appVersion: null }, deps({ fetch: bad.fetch }));
		expect(logged.join("\n")).not.toContain(KEY);
	});
});

// ── refresh ────────────────────────────────────────────────────────

describe("refresh", () => {
	it("success: the new token replaces the old, failures reset", async () => {
		const old = await storeValid();
		await rpc.recordLicenceFailure(null, null);
		clock += 2 * DAY;
		const server = fakeServer(async () => ({ status: 200, body: { token: await mint({ deployment_id: (await rpc.getLicence()).deploymentId }, clock), refresh_after: clock + DAY } }));
		expect(await refreshLicence(env, deps({ fetch: server.fetch }))).toBe("refreshed");
		const rec = await rpc.getLicence();
		expect(rec.token).not.toBe(old);
		expect(rec.failureCount).toBe(0);
		expect(server.calls[0]).toEqual({ path: "/v1/licence/refresh", body: { token: old } });
	});

	it("failure: keeps the old token and counts failures; not locked while valid", async () => {
		const old = await storeValid();
		const down = fakeServer(() => ({ status: 503, body: { error: "upstream_busy" } }));
		for (let i = 0; i < 3; i++) {
			clock += DAY;
			expect(await refreshLicence(env, deps({ fetch: down.fetch }))).toBe("failed");
		}
		const rec = await rpc.getLicence();
		expect(rec.token).toBe(old);
		expect(rec.failureCount).toBe(3);
		invalidateLicenceCache(env);
		expect(await licenceState(env, deps())).toMatchObject({ status: "active", locked: false });
	});

	it("grace: refresh failing past exp shows grace, then locks past 7 days", async () => {
		await storeValid();
		const down = fakeServer(() => ({ status: 503, body: { error: "upstream_busy" } }));
		clock += 31 * DAY;
		expect(await refreshLicence(env, deps({ fetch: down.fetch }))).toBe("failed");
		invalidateLicenceCache(env);
		expect(await licenceState(env, deps())).toMatchObject({ status: "grace", locked: false });
		clock += 7 * DAY;
		invalidateLicenceCache(env);
		expect(await licenceState(env, deps())).toMatchObject({ status: "expired", locked: true });
	});

	it("revoked (410): locks at once, keeps the token for the record", async () => {
		await storeValid();
		const gone = fakeServer(() => ({ status: 410, body: { error: "revoked", reason: "instance_deactivated" } }));
		clock += DAY;
		expect(await refreshLicence(env, deps({ fetch: gone.fetch }))).toBe("terminal");
		invalidateLicenceCache(env);
		const s = await licenceState(env, deps());
		expect(s).toMatchObject({ status: "revoked", locked: true });
		expect(licenceView(s).serverReason).toBe("revoked: instance_deactivated");
	});

	it("runs from the cron only when due, and once across isolates", async () => {
		await storeValid();
		const server = fakeServer(async () => ({ status: 200, body: { token: await mint({ deployment_id: (await rpc.getLicence()).deploymentId }, clock), refresh_after: clock + DAY } }));
		expect(await maybeRefreshLicence(env, deps({ fetch: server.fetch }))).toBe("skipped");
		expect(server.calls).toHaveLength(0);
		clock += DAY + 1;
		const [a, b] = await Promise.all([maybeRefreshLicence(env, deps({ fetch: server.fetch })), maybeRefreshLicence(env, deps({ fetch: server.fetch }))]);
		expect([a, b].sort()).toEqual(["refreshed", "skipped"]);
		expect(server.calls).toHaveLength(1);
	});

	it("the cron tick calls it", () => {
		const app = readFileSync(join(ROOT, "workers/app.ts"), "utf8");
		const scheduled = app.slice(app.indexOf("async scheduled("), app.indexOf("async email("));
		expect(scheduled).toContain("maybeRefreshLicence(env)");
	});
});

// ── this repo off, the template enforce ────────────────────────────

describe("enforcement per build", () => {
	it("this repo's wrangler.jsonc has off", () => {
		const cfg = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
		expect(cfg.vars.LICENCE_ENFORCEMENT).toBe("off");
	});

	it("the template build sets enforce", () => {
		const out = rewriteWrangler(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
		expect(parseJsonc(out).vars.LICENCE_ENFORCEMENT).toBe("enforce");
		expect(out).not.toContain("vendor's own");
	});

	it("the template build refuses a source that is not off", () => {
		const src = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").replace('"LICENCE_ENFORCEMENT": "off"', '"LICENCE_ENFORCEMENT": "enforce"');
		expect(() => rewriteWrangler(src)).toThrow();
	});
});

// ── vendored verifier and bundled keys ─────────────────────────────

describe("vendored verifier and keys", () => {
	it("shared/licence-token.ts is the licence server's file, unchanged below the header", () => {
		const text = readFileSync(join(ROOT, "shared/licence-token.ts"), "utf8");
		const pinned = text.match(/SHA-256 of the original: ([0-9a-f]{64})/)![1];
		const body = text.slice(text.indexOf("/**\n * Tapetide licence token"));
		expect(createHash("sha256").update(body).digest("hex")).toBe(pinned);
	});

	it("bundles only public keys", () => {
		for (const jwk of Object.values(LICENCE_KEYS) as (Ed25519PublicJwk & { d?: string })[]) {
			expect(jwk.d).toBeUndefined();
			expect(Object.keys(jwk).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
		}
		expect(LICENCE_KEYS[DEV_KEY_ID]).toBeDefined();
	});

	it("onlyDevKey tells the dev key apart from a real one", () => {
		expect(onlyDevKey({ [DEV_KEY_ID]: LICENCE_KEYS[DEV_KEY_ID] })).toBe(true);
		expect(onlyDevKey({ [DEV_KEY_ID]: LICENCE_KEYS[DEV_KEY_ID], "2026-1": { ...LICENCE_KEYS[DEV_KEY_ID], kid: "2026-1" } })).toBe(false);
		expect(onlyDevKey({})).toBe(true);
	});

	/**
	 * The production guard. `LICENCE_ENV=production npm test` (the release
	 * build) fails while the development key is still the only bundled key, and
	 * also while it is bundled at all.
	 */
	it.runIf(process.env.LICENCE_ENV === "production")("a production build has a production key, not only the development key", () => {
		expect(onlyDevKey(), "add the production public key to shared/licence-keys.ts").toBe(false);
	});

	it("a production build never accepts the development key", () => {
		const prod = verificationJwks(false);
		expect(prod.keys.map((k) => k.kid)).toEqual([PRODUCTION_KEY_ID]);
		expect(verificationJwks(true).keys.map((k) => k.kid).sort()).toEqual([PRODUCTION_KEY_ID, DEV_KEY_ID].sort());
		// The production key is the one the live server publishes (GET /v1/keys).
		expect(LICENCE_KEYS[PRODUCTION_KEY_ID].x).toBe("x5OBKJi2mygfWPHZDvYOp6vrf1_aGDXHWFstuFBDE50");
	});

	it("the deployed bundle drops the development key (vite statically replaces import.meta.env.DEV)", () => {
		const src = readFileSync(join(ROOT, "shared/licence-keys.ts"), "utf8");
		expect(src).toMatch(/LICENCE_JWKS: Jwks = verificationJwks\(import\.meta\.env\?\.DEV === true\)/);
	});
});
