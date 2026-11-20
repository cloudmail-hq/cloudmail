/**
 * Per-domain sending provider: the transport router behind `sendEmail`, the
 * encrypted settings store (migration 0026), and the
 * `/api/v1/domains/:id/sending` routes. No network: SES answers come from a
 * fake fetch, and credentials are built at runtime so scanners don't flag them.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, AUTH_MIGRATION_NAMES, type AuthSql } from "../workers/auth/store-core";
import { DomainStore } from "../workers/lib/domain-store";
import { DomainSendingStore, openSesSecret, sealSesSecret } from "../workers/lib/domain-sending-store";
import {
	CloudflareTransport,
	invalidateTransportCache,
	mailTransportDeps,
	resolveTransport,
	SesTransport,
	TransportError,
} from "../workers/lib/mail-transport";
import { sendEmail } from "../workers/email-sender";
import { sesTransportDeps } from "../workers/lib/ses-transport";
import { providerSendDeps } from "../workers/lib/provider-send";
import { clearanceForTest } from "../workers/lib/pre-send";
import { classifySendFailure } from "../workers/lib/held-send";
import { describeSendError } from "../shared/send-errors";
import { domainSendingDeps, domainsRoutes } from "../workers/routes/domains";
import { applyTokenRestriction, decidePrincipal } from "../workers/lib/authz";
import { SES_REGIONS, isSesRegion, sesDkimRecords, sesIamPolicy } from "../shared/ses-sending";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";

const AUTH_SECRET = "domain-sending-test-secret-0123456789";
// Shaped like IAM credentials, assembled at runtime.
const KEY_ID = ["AKIA", "TESTKEY00000", "LAST"].join("");
const SECRET = ["fake", "Secret", "/+="].join("").padEnd(40, "q");
const OTHER_SECRET = "other".padEnd(40, "z");

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

let db: DatabaseSync;
let auth: AuthStore;
let domains: DomainStore;
let sending: DomainSendingStore;
let objects: Map<string, string>;
let now: number;

/** One object answering every AuthDO method these paths use, as the DO does. */
function rpc() {
	const sendingMethods: Record<string, (...a: any[]) => unknown> = {
		getDomainSending: (h: string) => sending.get(h),
		putDomainSending: (i: any) => sending.put(i),
		recordDomainSendingTest: (h: string, r: any) => sending.recordTest(h, r),
		deleteDomainSending: (h: string) => sending.delete(h),
	};
	return new Proxy(
		{},
		{
			get: (_t, name: string) => async (...args: unknown[]) => {
				if (sendingMethods[name]) return sendingMethods[name](...args);
				if (typeof (domains as any)[name] === "function") return (domains as any)[name](...args);
				return (auth as any)[name](...args);
			},
		},
	);
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	auth = new AuthStore(sql, tx);
	domains = new DomainStore(sql, tx);
	sending = new DomainSendingStore(sql, tx);
	objects = new Map();
	now = Date.UTC(2026, 10, 8);
	domains.createDomain({ hostname: "ses.example", now: 1 });
	domains.createDomain({ hostname: "cf.example", now: 1 });
	invalidateTransportCache();
	mailTransportDeps.now = () => now;
	mailTransportDeps.store = undefined;
	domainSendingDeps.now = () => now;
	domainSendingDeps.fetchImpl = undefined;
	domainSendingDeps.sleep = async () => {};
	mailTransportDeps.sleep = async () => {};
	providerSendDeps.sleep = async () => {};
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function fakeBinding() {
	const send = vi.fn(async (_m: unknown) => ({ messageId: "cf-provider-id" }));
	return { binding: { send } as unknown as SendEmail, send };
}

function mailEnv(binding: SendEmail) {
	const stub = rpc();
	return { EMAIL: binding, AUTH_SECRET, AUTH_STORE: { idFromName: () => "global", get: () => stub } };
}

async function storeSes(hostname = "ses.example", extra: { secret?: string | null; region?: string | null } = {}) {
	const secretEnc =
		extra.secret === null ? null : await sealSesSecret(extra.secret ?? SECRET, AUTH_SECRET, hostname);
	sending.put({
		hostname,
		provider: "ses",
		region: extra.region === undefined ? "eu-west-1" : extra.region,
		accessKeyId: KEY_ID,
		secretEnc,
		configurationSet: null,
		updatedBy: "owner@example.com",
		now,
	});
}

const MSG = (from: string) => ({ to: "someone@elsewhere.example", from, subject: "Hi", text: "Hello" });

// -- migration -------------------------------------------------------------------

describe("migrations 0026_domain_sending and 0027_domain_sending_events", () => {
	it("run in order and leave the table with a provider check that allows resend", () => {
		expect(AUTH_MIGRATION_NAMES.indexOf("0026_domain_sending")).toBe(AUTH_MIGRATION_NAMES.indexOf("0025_licence") + 1);
		expect(AUTH_MIGRATION_NAMES.indexOf("0027_domain_sending_events")).toBe(AUTH_MIGRATION_NAMES.indexOf("0026_domain_sending") + 1);
		const cols = (db.prepare("PRAGMA table_info(domain_sending)").all() as { name: string }[]).map((c) => c.name);
		expect(cols).toEqual([
			"hostname",
			"provider",
			"region",
			"access_key_id",
			"secret_enc",
			"configuration_set",
			"last_test",
			"updated_at",
			"updated_by",
			"sns_topic_arn",
			"webhook_id",
			"resend_key_enc",
			"resend_key_last4",
			"resend_webhook_secret_enc",
			"last_event",
		]);
		expect(() =>
			db.prepare("INSERT INTO domain_sending (hostname, provider, updated_at) VALUES ('x', 'mailgun', 1)").run(),
		).toThrow();
		expect(() =>
			db.prepare("INSERT INTO domain_sending (hostname, provider, updated_at) VALUES ('y', 'resend', 1)").run(),
		).not.toThrow();
	});

	it("0027 keeps existing rows, gives each a webhook id and sets the marker", () => {
		const raw = new DatabaseSync(":memory:");
		raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		raw.exec(`CREATE TABLE domain_sending (hostname TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'ses')),
			region TEXT, access_key_id TEXT, secret_enc TEXT, configuration_set TEXT, last_test TEXT, updated_at INTEGER NOT NULL, updated_by TEXT)`);
		raw.exec(`INSERT INTO domain_sending (hostname, provider, region, updated_at) VALUES ('old.example', 'ses', 'eu-west-1', 5)`);
		// Mark every earlier migration applied, so the runner applies only 0027.
		const { sql, tx } = adapter(raw);
		raw.exec(`CREATE TABLE applied_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
		for (const name of AUTH_MIGRATION_NAMES.filter((n) => n !== "0027_domain_sending_events")) {
			raw.prepare(`INSERT INTO applied_migrations (name, applied_at) VALUES (?, 0)`).run(name);
		}
		new AuthStore(sql, tx);
		const row = raw.prepare(`SELECT * FROM domain_sending WHERE hostname = 'old.example'`).get() as Record<string, unknown>;
		expect(row).toMatchObject({ provider: "ses", region: "eu-west-1", updated_at: 5 });
		expect(String(row.webhook_id)).toMatch(/^[0-9a-f]{32}$/);
		expect(raw.prepare(`SELECT value FROM meta WHERE key = 'sending.any_non_cloudflare'`).get()).toEqual({ value: "1" });
	});

	it("reapplying migrations on the same database is a no-op", () => {
		const { sql, tx } = adapter(db);
		expect(() => new AuthStore(sql, tx)).not.toThrow();
	});
});

// -- store -------------------------------------------------------------------------

describe("DomainSendingStore", () => {
	it("binds the ciphertext to its hostname", async () => {
		const enc = await sealSesSecret(SECRET, AUTH_SECRET, "ses.example");
		expect(enc).not.toContain(SECRET);
		expect(await openSesSecret(enc, AUTH_SECRET, "ses.example")).toBe(SECRET);
		await expect(openSesSecret(enc, AUTH_SECRET, "cf.example")).rejects.toThrow();
		await expect(openSesSecret(enc, "another-secret-entirely-000000", "ses.example")).rejects.toThrow();
	});

	it("keeps the stored secret when a put omits it, and always moves updated_at forward", async () => {
		await storeSes();
		const first = sending.get("ses.example")!;
		const second = sending.put({ ...first, provider: "ses", configurationSet: "cs", updatedBy: null, now });
		expect(second.secretEnc).toBe(first.secretEnc);
		expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
	});

	it("delete wipes the row, secret included", async () => {
		await storeSes();
		expect(sending.delete("ses.example")).toBe(true);
		expect(sending.get("ses.example")).toBeNull();
		expect(sending.delete("ses.example")).toBe(false);
	});
});

// -- transport routing ---------------------------------------------------------------

describe("resolveTransport / sendEmail routing", () => {
	it("a domain with no setting sends through Cloudflare, unchanged", async () => {
		const { binding, send } = fakeBinding();
		const env = mailEnv(binding);
		expect(await resolveTransport(env, "a@cf.example")).toBeInstanceOf(CloudflareTransport);
		await expect(sendEmail(env, MSG("a@cf.example"), clearanceForTest())).resolves.toEqual({ messageId: "cf-provider-id" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]![0]).toMatchObject({ to: "someone@elsewhere.example", from: "a@cf.example", subject: "Hi" });
	});

	it("a bare binding (tests) is always Cloudflare", async () => {
		const { binding } = fakeBinding();
		expect(await resolveTransport(binding, "a@ses.example")).toBeInstanceOf(CloudflareTransport);
	});

	it("routes per domain: SES for one, Cloudflare for the other", async () => {
		await storeSes();
		const { binding } = fakeBinding();
		const env = mailEnv(binding);
		expect(await resolveTransport(env, "a@ses.example")).toBeInstanceOf(SesTransport);
		expect(await resolveTransport(env, "Name <b@CF.example>")).toBeInstanceOf(CloudflareTransport);
	});

	it("an SES domain sends through SES (fake endpoint), never via Cloudflare, and a refusal carries no secret", async () => {
		await storeSes();
		const { binding, send } = fakeBinding();
		const calls: Request[] = [];
		sesTransportDeps.fetchImpl = (async (input: RequestInfo | URL) => {
			calls.push(input as Request);
			return new Response(JSON.stringify({ message: "Email address is not verified." }), {
				status: 400,
				headers: { "x-amzn-errortype": "MessageRejected:" },
			});
		}) as typeof fetch;
		try {
			const err = await sendEmail(mailEnv(binding), MSG("a@ses.example"), clearanceForTest()).catch((e) => e);
			expect(err.code).toBe("E_SES_MESSAGE_REJECTED");
			expect(classifySendFailure(err)).toBe("rejected");
			expect(describeSendError(err)).toMatch(/SES said: Email address is not verified\..*\(E_SES_MESSAGE_REJECTED\)/);
			expect(send).not.toHaveBeenCalled();
			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
			expect(JSON.stringify(err)).not.toContain(SECRET);
			expect(String(err.message)).not.toContain(SECRET);
		} finally {
			sesTransportDeps.fetchImpl = undefined;
		}
	});

	it("an SES domain with incomplete settings fails as not configured", async () => {
		await storeSes("ses.example", { secret: null });
		const { binding, send } = fakeBinding();
		const err = await sendEmail(mailEnv(binding), MSG("a@ses.example"), clearanceForTest()).catch((e) => e);
		expect(err.code).toBe("E_PROVIDER_NOT_CONFIGURED");
		expect(classifySendFailure(err)).toBe("rejected");
		expect(send).not.toHaveBeenCalled();
	});

	it("a secret that no longer decrypts fails as not configured, not as Cloudflare", async () => {
		await storeSes();
		const { binding, send } = fakeBinding();
		const env = { ...mailEnv(binding), AUTH_SECRET: "a-different-auth-secret-000000000" };
		const err = await sendEmail(env, MSG("a@ses.example"), clearanceForTest()).catch((e) => e);
		expect(err.code).toBe("E_PROVIDER_NOT_CONFIGURED");
		expect(send).not.toHaveBeenCalled();
	});

	it("a settings lookup that fails with nothing cached fails closed", async () => {
		const { binding, send } = fakeBinding();
		mailTransportDeps.store = () => ({
			getOrInitMeta: async () => "x",
			getDomainSending: async () => {
				throw new Error("AuthDO unavailable");
			},
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const err = await sendEmail(mailEnv(binding), MSG("a@ses.example"), clearanceForTest()).catch((e) => e);
		expect(err.code).toBe("E_PROVIDER_LOOKUP_FAILED");
		expect(classifySendFailure(err)).toBe("rejected");
		expect(send).not.toHaveBeenCalled();
	});

	it("caches per isolate and picks up a change once invalidated or expired", async () => {
		const { binding } = fakeBinding();
		const env = mailEnv(binding);
		expect(await resolveTransport(env, "a@ses.example")).toBeInstanceOf(CloudflareTransport);
		await storeSes();
		// Still cached as Cloudflare within the TTL.
		expect(await resolveTransport(env, "a@ses.example")).toBeInstanceOf(CloudflareTransport);
		invalidateTransportCache("ses.example");
		expect(await resolveTransport(env, "a@ses.example")).toBeInstanceOf(SesTransport);
		sending.delete("ses.example");
		now += 31_000;
		expect(await resolveTransport(env, "a@ses.example")).toBeInstanceOf(CloudflareTransport);
	});

	it("keeps the Cloudflare header chokepoint for Cloudflare domains", async () => {
		const { binding, send } = fakeBinding();
		await expect(
			sendEmail(mailEnv(binding), { ...MSG("a@cf.example"), headers: { "Message-ID": "<x@y>" } }, clearanceForTest()),
		).rejects.toMatchObject({ code: "E_HEADER_NOT_ALLOWED" });
		expect(send).not.toHaveBeenCalled();
	});

	it("an SesTransport never exposes its credentials", async () => {
		await storeSes();
		const t = await resolveTransport(mailEnv(fakeBinding().binding), "a@ses.example");
		expect(JSON.stringify(t)).not.toContain(SECRET);
		expect(JSON.stringify(t)).not.toContain(KEY_ID);
	});
});

// -- routes --------------------------------------------------------------------------

type Who = "admin" | "member" | "scoped-token" | "domains-token";

function makeApp(who: Who = "admin") {
	const app = new Hono<MailboxContext>();
	const admin = () =>
		decidePrincipal({ adminEmails: ["owner@example.com"], identity: { kind: "user", id: "owner@example.com", subject: null } });
	app.use("*", async (c, next) => {
		let principal = admin();
		if (who === "member") {
			principal = decidePrincipal({
				adminEmails: ["owner@example.com"],
				identity: { kind: "user", id: "member@example.com", subject: null },
			});
		}
		if (who === "scoped-token") principal = applyTokenRestriction(admin(), { id: "t1", scopes: ["mail:read", "mail:send"], mailboxes: null });
		if (who === "domains-token") principal = applyTokenRestriction(admin(), { id: "t2", scopes: ["domains:manage"], mailboxes: null });
		c.set("principal", principal);
		return next();
	});
	app.route("/api/v1/domains", domainsRoutes);
	const stub = rpc();
	const env = {
		AUTH_SECRET,
		AUTH_STORE: { idFromName: () => "global", get: () => stub },
		BUCKET: {
			put: async (key: string, value: string) => void objects.set(key, value),
			head: async () => null,
			list: async () => ({ objects: [], truncated: false }),
		},
		DOMAINS: "",
	} as unknown as Env;
	const call = (method: string, path: string, body?: unknown) =>
		app.request(
			path,
			{ method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
			env,
		);
	return { call };
}

const P = "/api/v1/domains/ses.example/sending";
const SES_BODY = { provider: "ses", region: "eu-west-1", accessKeyId: KEY_ID, secretAccessKey: SECRET };

function auditEntries(): any[] {
	return [...objects.entries()].filter(([k]) => k.startsWith("audit/")).map(([, v]) => JSON.parse(v));
}

/** A fake SES v2 API. Records each request's URL and whether it was signed. */
function fakeSes(routes: Record<string, { status: number; body: unknown; type?: string }>) {
	const calls: { url: string; signed: boolean }[] = [];
	const impl = (async (input: RequestInfo | URL) => {
		const req = input as Request;
		const url = new URL(req.url);
		calls.push({ url: req.url, signed: (req.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256") });
		const hit = routes[`${url.host}${url.pathname}`];
		if (!hit) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
		return new Response(JSON.stringify(hit.body), {
			status: hit.status,
			headers: { "content-type": "application/json", ...(hit.type ? { "x-amzn-errortype": hit.type } : {}) },
		});
	}) as typeof fetch;
	return { impl, calls };
}

const HEALTHY = {
	"email.eu-west-1.amazonaws.com/v2/email/account": {
		status: 200,
		body: {
			SendingEnabled: true,
			ProductionAccessEnabled: false,
			EnforcementStatus: "HEALTHY",
			SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 3 },
		},
	},
	"email.eu-west-1.amazonaws.com/v2/email/identities/ses.example": {
		status: 200,
		body: {
			IdentityType: "DOMAIN",
			VerifiedForSendingStatus: true,
			VerificationStatus: "SUCCESS",
			DkimAttributes: { SigningEnabled: true, Status: "SUCCESS", Tokens: ["tok1abc", "tok2def", "tok3ghi"] },
		},
	},
};

/** HEALTHY with the DKIM status replaced (a deep copy). */
function withDkim(status: string): Record<string, { status: number; body: any; type?: string }> {
	const routes = JSON.parse(JSON.stringify(HEALTHY));
	routes["email.eu-west-1.amazonaws.com/v2/email/identities/ses.example"].body.DkimAttributes.Status = status;
	return routes;
}

/** Save SES settings, pass a test, save again: the domain now sends through SES. */
async function enableSes() {
	await makeApp().call("PUT", P, SES_BODY);
	domainSendingDeps.fetchImpl = fakeSes(HEALTHY).impl;
	await makeApp().call("POST", `${P}/test`);
	const res = (await (await makeApp().call("PUT", P, { provider: "ses", region: "eu-west-1", accessKeyId: KEY_ID })).json()) as any;
	expect(res.provider).toBe("ses");
}

describe("GET /api/v1/domains/:id/sending", () => {
	it("defaults to Cloudflare", async () => {
		const res = await makeApp().call("GET", P);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ domain: "ses.example", provider: "cloudflare", ses: null, lastTest: null, iamPolicy: null });
	});

	it("404 for an unknown domain", async () => {
		expect((await makeApp().call("GET", "/api/v1/domains/nope.example/sending")).status).toBe(404);
	});
});

describe("permissions", () => {
	it.each([
		["GET", P],
		["PUT", P],
		["DELETE", P],
		["POST", `${P}/test`],
	])("a member gets 403 on %s %s", async (method, path) => {
		const res = await makeApp("member").call(method, path, method === "PUT" ? SES_BODY : undefined);
		expect(res.status).toBe(403);
		expect(sending.get("ses.example")).toBeNull();
	});

	it.each([
		["GET", P],
		["PUT", P],
		["DELETE", P],
		["POST", `${P}/test`],
	])("a token without domains:manage gets 403 on %s %s", async (method, path) => {
		const res = await makeApp("scoped-token").call(method, path, method === "PUT" ? SES_BODY : undefined);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ scope: "domains:manage" });
	});

	it("a token with domains:manage may read and set it", async () => {
		const app = makeApp("domains-token");
		expect((await app.call("GET", P)).status).toBe(200);
		expect((await app.call("PUT", P, SES_BODY)).status).toBe(200);
	});
});

describe("PUT /api/v1/domains/:id/sending", () => {
	it("stores SES encrypted, returns last 4 only, audits without the secret, and logs nothing secret", async () => {
		const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
		const res = await makeApp().call("PUT", P, { ...SES_BODY, configurationSet: "cloudmail" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		// Saved, but not switched: no passing test of these settings yet.
		expect(body).toMatchObject({
			provider: "cloudflare",
			ses: { region: "eu-west-1", accessKeyIdLast4: "LAST", secretStored: true, configurationSet: "cloudmail" },
			updatedBy: "owner@example.com",
			webhook: { provider: "ses", path: expect.stringMatching(/^\/hooks\/ses\/[0-9a-f]{32}$/) },
		});
		expect(body.blockedReason).toMatch(/Test connection/);
		const text = JSON.stringify(body);
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(KEY_ID);
		expect(body.iamPolicy.Statement[0].Resource).toContain("arn:aws:ses:eu-west-1:ACCOUNT_ID:identity/ses.example");

		const row = sending.get("ses.example")!;
		expect(row.secretEnc).not.toContain(SECRET);
		expect(await openSesSecret(row.secretEnc!, AUTH_SECRET, "ses.example")).toBe(SECRET);

		const entries = auditEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			action: "domain.change",
			target: "ses.example",
			detail: { op: "sending.stage", provider: "cloudflare", requested: "ses", region: "eu-west-1", keyIdLast4: "LAST", secretReplaced: true },
		});
		expect(JSON.stringify(entries)).not.toContain(SECRET);
		expect(JSON.stringify(entries)).not.toContain(KEY_ID);
		for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);

		// And the next GET never returns it either.
		const get = await (await makeApp().call("GET", P)).text();
		expect(get).not.toContain(SECRET);
		expect(get).toContain('"secretStored":true');
	});

	it("omitting the secret keeps the stored one for the same key ID", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		const before = sending.get("ses.example")!.secretEnc;
		const res = await makeApp().call("PUT", P, { provider: "ses", region: "eu-west-2", accessKeyId: KEY_ID });
		expect(res.status).toBe(200);
		expect(sending.get("ses.example")!.secretEnc).toBe(before);
		expect(auditEntries().at(-1).detail.secretReplaced).toBe(false);
	});

	it("requires the secret the first time and for a new key ID", async () => {
		const first = await makeApp().call("PUT", P, { provider: "ses", region: "eu-west-1", accessKeyId: KEY_ID });
		expect(first.status).toBe(400);
		expect(await first.json()).toMatchObject({ code: "secret_required" });
		await makeApp().call("PUT", P, SES_BODY);
		const otherKey = ["AKIA", "OTHERKEY0000", "ABCD"].join("");
		const res = await makeApp().call("PUT", P, { provider: "ses", region: "eu-west-1", accessKeyId: otherKey });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "secret_required" });
	});

	it("rejects bad input without echoing the value", async () => {
		const badSecret = "x".repeat(12);
		for (const body of [
			{ ...SES_BODY, region: "moon-1" },
			{ ...SES_BODY, accessKeyId: "nope" },
			{ ...SES_BODY, secretAccessKey: badSecret },
			{ ...SES_BODY, extra: true },
			{ provider: "mailgun" },
		]) {
			const res = await makeApp().call("PUT", P, body);
			expect(res.status).toBe(400);
			expect(await res.text()).not.toContain(badSecret);
		}
		expect(sending.get("ses.example")).toBeNull();
	});

	it("switches to SES only after a passing test of the saved settings (DKIM SUCCESS)", async () => {
		const first = (await (await makeApp().call("PUT", P, SES_BODY)).json()) as any;
		expect(first.provider).toBe("cloudflare");
		// DKIM pending: the test records, the gate stays shut.
		domainSendingDeps.fetchImpl = fakeSes(withDkim("PENDING")).impl;
		const t1 = (await (await makeApp().call("POST", `${P}/test`)).json()) as any;
		expect(t1.test).toMatchObject({ sendingAllowed: false, blockedReason: expect.stringMatching(/DKIM/) });
		const second = (await (await makeApp().call("PUT", P, { provider: "ses", region: "eu-west-1", accessKeyId: KEY_ID })).json()) as any;
		expect(second.provider).toBe("cloudflare");
		expect(second.blockedReason).toMatch(/DKIM/);
		// DKIM verified: the next save switches.
		domainSendingDeps.fetchImpl = fakeSes(HEALTHY).impl;
		await makeApp().call("POST", `${P}/test`);
		const third = (await (await makeApp().call("PUT", P, { provider: "ses", region: "eu-west-1", accessKeyId: KEY_ID })).json()) as any;
		expect(third).toMatchObject({ provider: "ses", blockedReason: null });
		expect(sending.anyNonCloudflare()).toBe(true);
	});

	it("switching to Cloudflare routes back at once but keeps the SES settings", async () => {
		const { binding, send } = fakeBinding();
		await enableSes();
		const env = mailEnv(binding);
		expect(await resolveTransport(env, "a@ses.example")).toBeInstanceOf(SesTransport);
		const res = await makeApp().call("PUT", P, { provider: "cloudflare" });
		expect(await res.json()).toMatchObject({ provider: "cloudflare", ses: { secretStored: true, accessKeyIdLast4: "LAST" } });
		// Invalidated in this isolate by the write.
		await sendEmail(env, MSG("a@ses.example"), clearanceForTest());
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("DELETE /api/v1/domains/:id/sending", () => {
	it("resets to Cloudflare and wipes the secret", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		const res = await makeApp().call("DELETE", P);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ provider: "cloudflare", ses: null });
		expect(sending.get("ses.example")).toBeNull();
		expect(auditEntries().at(-1)).toMatchObject({ detail: { op: "sending.reset" } });
	});
});

describe("POST /api/v1/domains/:id/sending/test", () => {
	it("412 when nothing is configured", async () => {
		const res = await makeApp().call("POST", `${P}/test`);
		expect(res.status).toBe(412);
	});

	it("reports sandbox, quota, verification and DKIM CNAMEs, signed, and records the result", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		const ses = fakeSes(HEALTHY);
		domainSendingDeps.fetchImpl = ses.impl;
		const res = await makeApp().call("POST", `${P}/test`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.test).toMatchObject({
			ok: true,
			region: "eu-west-1",
			account: { ok: true, sendingEnabled: true, sandbox: true, productionAccess: false, quota: { max24HourSend: 200, maxSendRate: 1, sentLast24Hours: 3 } },
			identity: { ok: true, verifiedForSending: true, verificationStatus: "SUCCESS", dkim: { status: "SUCCESS", signingEnabled: true } },
		});
		expect(body.test.identity.dkim.records).toEqual([
			{ type: "CNAME", name: "tok1abc._domainkey.ses.example", value: "tok1abc.dkim.amazonses.com", purpose: "dkim" },
			{ type: "CNAME", name: "tok2def._domainkey.ses.example", value: "tok2def.dkim.amazonses.com", purpose: "dkim" },
			{ type: "CNAME", name: "tok3ghi._domainkey.ses.example", value: "tok3ghi.dkim.amazonses.com", purpose: "dkim" },
		]);
		expect(ses.calls.map((c) => c.url)).toEqual([
			"https://email.eu-west-1.amazonaws.com/v2/email/account",
			"https://email.eu-west-1.amazonaws.com/v2/email/identities/ses.example",
		]);
		expect(body.test).toMatchObject({ provider: "ses", sendingAllowed: true, blockedReason: null });
		expect(ses.calls.every((c) => c.signed)).toBe(true);
		expect(JSON.stringify(body)).not.toContain(SECRET);
		expect(sending.get("ses.example")!.lastTest).toMatchObject({ ok: true });
		expect(body.sending.lastTest).toMatchObject({ ok: true });
	});

	it("maps an invalid key and a missing identity to plain codes", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		domainSendingDeps.fetchImpl = fakeSes({
			"email.eu-west-1.amazonaws.com/v2/email/account": {
				status: 403,
				type: "UnrecognizedClientException:",
				body: { message: "The security token included in the request is invalid." },
			},
			"email.eu-west-1.amazonaws.com/v2/email/identities/ses.example": {
				status: 404,
				type: "NotFoundException:",
				body: { message: "Email identity ses.example does not exist." },
			},
		}).impl;
		const body = (await (await makeApp().call("POST", `${P}/test`)).json()) as any;
		expect(body.test.ok).toBe(false);
		expect(body.test.account).toMatchObject({ ok: false, code: "invalid_credentials" });
		expect(body.test.identity).toMatchObject({ ok: false, code: "identity_not_found" });
	});

	it("tests unsaved values without recording them against the stored settings", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		domainSendingDeps.fetchImpl = fakeSes(HEALTHY).impl;
		const res = await makeApp().call("POST", `${P}/test`, { secretAccessKey: OTHER_SECRET });
		expect(res.status).toBe(200);
		expect(sending.get("ses.example")!.lastTest).toBeNull();
		expect(await res.text()).not.toContain(OTHER_SECRET);
	});

	it("never pairs the stored secret with a different key ID", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		const res = await makeApp().call("POST", `${P}/test`, { accessKeyId: ["AKIA", "OTHERKEY0000", "ABCD"].join("") });
		expect(res.status).toBe(412);
	});

	it("runs the checks one after another, never in parallel (1 request per second)", async () => {
		await makeApp().call("PUT", P, { ...SES_BODY, configurationSet: "cloudmail" });
		let inFlight = 0;
		let maxInFlight = 0;
		const sleeps: number[] = [];
		domainSendingDeps.sleep = async (ms) => void sleeps.push(ms);
		const base = fakeSes({
			...HEALTHY,
			"email.eu-west-1.amazonaws.com/v2/email/configuration-sets/cloudmail": { status: 200, body: { TrackingOptions: {} } },
			"email.eu-west-1.amazonaws.com/v2/email/configuration-sets/cloudmail/event-destinations": {
				status: 200,
				body: { EventDestinations: [{ Enabled: true, MatchingEventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT", "OPEN"] }] },
			},
		});
		domainSendingDeps.fetchImpl = (async (input: RequestInfo | URL) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 2));
			try {
				return await base.impl(input);
			} finally {
				inFlight--;
			}
		}) as typeof fetch;
		const body = (await (await makeApp().call("POST", `${P}/test`)).json()) as any;
		expect(maxInFlight).toBe(1);
		expect(sleeps.every((ms) => ms >= 1000)).toBe(true);
		expect(base.calls.map((c) => new URL(c.url).pathname)).toEqual([
			"/v2/email/account",
			"/v2/email/identities/ses.example",
			"/v2/email/configuration-sets/cloudmail",
			"/v2/email/configuration-sets/cloudmail/event-destinations",
		]);
		// Provider-side open tracking is detected and warned about.
		expect(body.test.configurationSet).toMatchObject({ ok: true, openTracking: true, clickTracking: false });
		expect(body.test.warnings.join(" ")).toMatch(/open tracking on/);
	});

	it("builds DKIM CNAMEs from SigningHostedZone and shows the MAIL FROM MX and SPF", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		const routes = withDkim("SUCCESS");
		(routes["email.eu-west-1.amazonaws.com/v2/email/identities/ses.example"].body as any).DkimAttributes.SigningHostedZone =
			"dkim.eu-west-1.amazonses.com";
		domainSendingDeps.fetchImpl = fakeSes(routes).impl;
		const body = (await (await makeApp().call("POST", `${P}/test`)).json()) as any;
		expect(body.test.identity.dkim.records[0]).toEqual({
			type: "CNAME",
			name: "tok1abc._domainkey.ses.example",
			value: "tok1abc.dkim.eu-west-1.amazonses.com",
			purpose: "dkim",
		});
		expect(body.test.mailFrom.records).toEqual([
			{ type: "MX", name: "bounce-ses.ses.example", value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10, purpose: "mail_from" },
			{ type: "TXT", name: "bounce-ses.ses.example", value: "v=spf1 include:amazonses.com ~all", purpose: "spf" },
		]);
	});

	it("an optional send test goes only to the SES mailbox simulator", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		domainSendingDeps.fetchImpl = fakeSes(HEALTHY).impl;
		const sent: any[] = [];
		sesTransportDeps.fetchImpl = (async (input: RequestInfo | URL) => {
			sent.push(JSON.parse(await (input as Request).text()));
			return new Response(JSON.stringify({ MessageId: "sim-1" }), { status: 200 });
		}) as typeof fetch;
		try {
			const body = (await (await makeApp().call("POST", `${P}/test`, { sendTest: true })).json()) as any;
			expect(body.test.sendTest).toMatchObject({ ok: true, to: "success@simulator.amazonses.com", messageId: "sim-1" });
			expect(sent).toHaveLength(1);
			expect(sent[0].Destination).toEqual({ ToAddresses: ["success@simulator.amazonses.com"] });
			expect(sent[0].FromEmailAddress).toBe("postmaster@ses.example");
		} finally {
			sesTransportDeps.fetchImpl = undefined;
		}
	});

	it("a changed key or region drops the recorded test", async () => {
		await makeApp().call("PUT", P, SES_BODY);
		domainSendingDeps.fetchImpl = fakeSes(HEALTHY).impl;
		await makeApp().call("POST", `${P}/test`);
		expect(sending.get("ses.example")!.lastTest).not.toBeNull();
		await makeApp().call("PUT", P, { provider: "ses", region: "us-east-1", accessKeyId: KEY_ID });
		expect(sending.get("ses.example")!.lastTest).toBeNull();
	});
});

describe("shared helpers", () => {
	it("drops DKIM tokens that are not plain labels", () => {
		expect(sesDkimRecords("x.example", ["ok1", "bad.token", "evil\nx"]).map((r) => r.name)).toEqual(["ok1._domainkey.x.example"]);
	});

	it("builds the research §8 policy: identity and config-set ARNs, FromAddress, SecureTransport, GetAccount on *", () => {
		const p = sesIamPolicy("X.example", "us-east-1", "cs", "123456789012");
		expect(p.Statement[0]).toEqual({
			Sid: "SendAsDomainThroughConfigSet",
			Effect: "Allow",
			Action: ["ses:SendEmail", "ses:SendRawEmail"],
			Resource: [
				"arn:aws:ses:us-east-1:123456789012:identity/x.example",
				"arn:aws:ses:us-east-1:123456789012:configuration-set/cs",
			],
			Condition: { StringLike: { "ses:FromAddress": "*@x.example" }, Bool: { "aws:SecureTransport": "true" } },
		});
		expect(p.Statement.find((s) => s.Sid === "ReadDomainIdentity")).toMatchObject({
			Action: ["ses:GetEmailIdentity"],
			Resource: "arn:aws:ses:us-east-1:123456789012:identity/x.example",
		});
		expect(p.Statement.find((s) => s.Sid === "ReadAccountStatus")).toMatchObject({ Action: ["ses:GetAccount"], Resource: "*" });
		// Without an account ID: a placeholder and the default config set.
		expect(sesIamPolicy("x.example", "eu-west-1").Statement[0]!.Resource).toEqual([
			"arn:aws:ses:eu-west-1:ACCOUNT_ID:identity/x.example",
			"arn:aws:ses:eu-west-1:ACCOUNT_ID:configuration-set/cloudmail",
		]);
	});

	it("accepts exactly the 33 commercial SES regions", () => {
		expect(SES_REGIONS).toHaveLength(33);
		expect(isSesRegion("ap-east-2")).toBe(true);
		expect(isSesRegion("us-gov-west-1")).toBe(false);
		expect(isSesRegion("evil.com/x-1")).toBe(false);
	});
});
