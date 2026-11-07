/**
 * Route-level guards for multi-domain management, through the real Hono app
 * with a fake AuthDO backed by a real `DomainStore` on node:sqlite:
 *
 * - creating a mailbox whose address is an alias is refused (otherwise the
 *   alias owner could send as it), and stale aliases are not sendable;
 * - provisioning an env (DOMAINS/ZONES) domain needs `confirmEnvDomain`.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../workers/index";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { DomainStore } from "../workers/lib/domain-store";
import { senderAddressesFor } from "../workers/routes/domains";

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

let store: DomainStore;
let objects: Map<string, string>;

/** Env with an R2 fake, a MailboxDO fake, and an AuthDO whose RPC is the DomainStore. */
function makeEnv(extra: Record<string, unknown> = {}) {
	const rpc = new Proxy(
		{},
		{ get: (_t, name: string) => async (...args: unknown[]) => (store as any)[name](...args) },
	);
	return {
		AUTH_MODE: "access", // unenforced: every caller is an admin
		AUTH_STORE: { idFromName: () => "global", get: () => rpc },
		BUCKET: {
			head: async (key: string) => (objects.has(key) ? { key } : null),
			get: async (key: string) => {
				const raw = objects.get(key);
				return raw === undefined ? null : { json: async () => JSON.parse(raw) };
			},
			put: async (key: string, value: string) => void objects.set(key, value),
			list: async (opts: { prefix?: string }) => ({
				objects: [...objects.keys()].filter((k) => k.startsWith(opts?.prefix ?? "")).map((key) => ({ key })),
				truncated: false,
			}),
		},
		MAILBOX: { idFromName: (n: string) => n, get: () => ({ getFolders: async () => [] }) },
		EMAIL_ADDRESSES: [],
		DOMAINS: "tapetide.com,producta.com",
		...extra,
	} as never;
}

const JSON_HEADERS = { "content-type": "application/json" };

beforeEach(() => {
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	new AuthStore(sql, tx);
	store = new DomainStore(sql, tx);
	objects = new Map([["mailboxes/bob@tapetide.com.json", "{}"]]);
});

describe("mailbox creation vs aliases", () => {
	it("refuses to create a mailbox at an address that is an alias", async () => {
		store.setAliases("bob@tapetide.com", ["sales@tapetide.com"], 1);
		const res = await app.request(
			"/api/v1/mailboxes",
			{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email: "Sales@tapetide.com", name: "Sales" }) },
			makeEnv(),
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/alias of bob@tapetide\.com\. Remove the alias/);
		expect(objects.has("mailboxes/sales@tapetide.com.json")).toBe(false);
	});

	it("still creates a mailbox that is nobody's alias", async () => {
		const res = await app.request(
			"/api/v1/mailboxes",
			{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email: "new@tapetide.com", name: "New" }) },
			makeEnv(),
		);
		expect(res.status).toBe(201);
	});

	it("does not let an alias that became a real mailbox be sent from", async () => {
		// A row that predates the guard: sales@ is bob's alias AND a real mailbox.
		store.setAliases("bob@tapetide.com", ["sales@tapetide.com", "sales@producta.com"], 1);
		objects.set("mailboxes/sales@tapetide.com.json", "{}");
		expect(await senderAddressesFor(makeEnv(), "bob@tapetide.com")).toEqual(["sales@producta.com"]);
	});
});

describe("mailbox deletion", () => {
	it("clears the mailbox's aliases and any catch-all pointing at it", async () => {
		store.setAliases("bob@tapetide.com", ["sales@producta.com"], 1);
		store.createDomain({ hostname: "producta.com", catchAllMailbox: "bob@tapetide.com", now: 1 });
		const base = makeEnv() as unknown as Record<string, any>;
		const env = {
			...base,
			BUCKET: { ...base.BUCKET, delete: async (k: string | string[]) => void [k].flat().forEach((x) => objects.delete(x)) },
			MAILBOX: { idFromName: (n: string) => n, get: () => ({ purge: async () => [] }) },
			EMAIL_AGENT: { idFromName: (n: string) => n, get: () => ({ purge: async () => {} }) },
		} as never;
		const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
		const res = await app.request("/api/v1/mailboxes/bob@tapetide.com", { method: "DELETE" }, env, ctx);
		expect(res.status).toBeLessThan(300);
		expect(store.listAliases("bob@tapetide.com")).toEqual([]);
		expect(store.getDomain("producta.com")?.catchAllMailbox).toBeNull();
	});
});

describe("provisioning an env domain", () => {
	it("needs confirmEnvDomain, and only for env domains", async () => {
		const env = makeEnv({ CF_API_TOKEN: "t" });
		// The list call seeds env domains into the store.
		await app.request("/api/v1/domains", {}, env);

		const refused = await app.request(
			"/api/v1/domains/tapetide.com/provision",
			{ method: "POST", headers: JSON_HEADERS, body: "{}" },
			env,
		);
		expect(refused.status).toBe(428);
		expect(((await refused.json()) as { code: string }).code).toBe("confirm_env_domain");

		// Confirmed: it reaches Cloudflare (here a zone lookup that finds nothing).
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 })) as typeof fetch;
		try {
			const confirmed = await app.request(
				"/api/v1/domains/tapetide.com/provision",
				{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ confirmEnvDomain: true }) },
				env,
			);
			expect(confirmed.status).toBe(200);
			const body = (await confirmed.json()) as { provision: { steps: { step: string; status: string }[] } };
			expect(body.provision.steps[0]).toMatchObject({ step: "zone", status: "error" });
		} finally {
			globalThis.fetch = realFetch;
		}

		// An API-added domain needs no confirmation.
		store.createDomain({ hostname: "productb.com", now: 1 });
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 })) as typeof fetch;
		try {
			const res = await app.request(
				"/api/v1/domains/productb.com/provision",
				{ method: "POST", headers: JSON_HEADERS, body: "{}" },
				makeEnv({ CF_API_TOKEN: "t" }),
			);
			expect(res.status).toBe(200);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("scoped API tokens on domain routes", () => {
	/** The real app behind a stand-in for `authenticate` that presents an API token. */
	async function asToken(scopes: string[] | null, path: string, init: RequestInit = {}) {
		const { Hono } = await import("hono");
		const outer = new Hono();
		outer.use("*", async (c, next) => {
			(c as any).set("authMethod", "token");
			(c as any).set("authToken", {
				id: "tok",
				userId: "u",
				name: "t",
				createdAt: 0,
				lastUsedAt: null,
				lastUsedIp: null,
				expiresAt: null,
				scopes,
				mailboxes: null,
				parentId: null,
			});
			return next();
		});
		outer.route("/", app as never);
		return outer.request(path, init, makeEnv());
	}

	it("domains:manage or admin passes; other scopes are refused", async () => {
		expect((await asToken(["domains:manage"], "/api/v1/domains")).status).toBe(200);
		expect((await asToken(["admin"], "/api/v1/domains")).status).toBe(200);
		expect((await asToken(null, "/api/v1/domains")).status).toBe(200);
		const refused = await asToken(["mail:read", "mail:send", "mailboxes:manage"], "/api/v1/domains");
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ code: "insufficient_scope", scope: "domains:manage" });
	});

	it("alias writes need domains:manage; alias reads need mail:read", async () => {
		const put = (scopes: string[]) =>
			asToken(scopes, "/api/v1/mailboxes/bob@tapetide.com/aliases", {
				method: "PUT",
				headers: JSON_HEADERS,
				body: JSON.stringify({ aliases: ["b@tapetide.com"] }),
			});
		expect((await put(["mail:read", "mailboxes:manage"])).status).toBe(403);
		expect((await put(["domains:manage"])).status).toBe(200);
		expect((await asToken(["mail:read"], "/api/v1/mailboxes/bob@tapetide.com/aliases")).status).toBe(200);
		expect((await asToken(["mail:send"], "/api/v1/mailboxes/bob@tapetide.com/aliases")).status).toBe(403);
	});

	it("a domains:manage token is not an admin anywhere else", async () => {
		expect((await asToken(["domains:manage"], "/api/v1/access")).status).toBe(403);
	});
});
