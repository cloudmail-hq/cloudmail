/**
 * Token resolution (`workers/lib/cf-connection.ts`) and the stored row
 * (`workers/lib/cf-connection-store.ts`, migration 0022) on real SQLite.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthStore, AUTH_MIGRATION_NAMES, type AuthSql } from "../workers/auth/store-core";
import { CloudflareConnectionStore, sealCloudflareToken, openCloudflareToken } from "../workers/lib/cf-connection-store";
import {
	CONNECTION_CACHE_MS,
	cfConnectionDeps,
	cloudflareClient,
	invalidateCloudflareConnectionCache,
	loadCloudflareConnection,
	resolveCloudflareToken,
	resolveWorkerScriptName,
	type CfConnectionStoreApi,
} from "../workers/lib/cf-connection";
import { analyticsTokens } from "../workers/lib/cf-analytics";
import type { Env } from "../workers/types";

const SECRET = "test-auth-secret-0123456789";
const TOKEN = "fake-cf-token-aaaaaaaaaaaaaaaaaaaaWXYZ";

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
let cf: CloudflareConnectionStore;
let reads: number;
let rpc: CfConnectionStoreApi;
let now: number;

beforeEach(() => {
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	auth = new AuthStore(sql, tx);
	cf = new CloudflareConnectionStore(sql, tx);
	reads = 0;
	rpc = {
		getOrInitMeta: (k, f) => auth.getOrInitMeta(k, f),
		getCloudflareConnection: async () => {
			reads++;
			return cf.get();
		},
	};
	now = 1_000_000;
	cfConnectionDeps.now = () => now;
	invalidateCloudflareConnectionCache();
});

const env = (extra: Record<string, unknown> = {}) => ({ AUTH_SECRET: SECRET, ...extra }) as unknown as Env;

async function connect(token = TOKEN, extra: Partial<Parameters<CloudflareConnectionStore["put"]>[0]> = {}) {
	return cf.put({
		tokenEnc: await sealCloudflareToken(token, SECRET),
		last4: token.slice(-4),
		accountId: "acc1",
		accountName: "Acme",
		tokenKind: "account",
		capabilities: [{ name: "zones.read", status: "ok" }],
		verifiedAt: now,
		createdBy: "o@example.com",
		now,
		...extra,
	});
}

describe("migration 0022_cloudflare_connection", () => {
	it("is appended after 0021 and allows one row only", async () => {
		const i = AUTH_MIGRATION_NAMES.indexOf("0022_cloudflare_connection");
		expect(i).toBe(AUTH_MIGRATION_NAMES.indexOf("0021_ai_usage_by_provider") + 1);
		await connect();
		await connect("fake-cf-token-bbbbbbbbbbbbbbbbbbbbbbbb");
		expect(cf.get()!.last4).toBe("bbbb");
	});
});

describe("CloudflareConnectionStore", () => {
	it("stores ciphertext only, round-trips metadata, and bumps updated_at on every write", async () => {
		const first = await connect();
		expect(first.tokenEnc).not.toContain(TOKEN);
		expect(await openCloudflareToken(first.tokenEnc, SECRET)).toBe(TOKEN);
		expect(first).toMatchObject({ accountId: "acc1", accountName: "Acme", tokenKind: "account", last4: "WXYZ" });
		expect(first.capabilities).toEqual([{ name: "zones.read", status: "ok" }]);

		const patched = cf.update({ workerScriptName: "my-mail" }, now)!;
		expect(patched.workerScriptName).toBe("my-mail");
		expect(patched.updatedAt).toBeGreaterThan(first.updatedAt);
		// A replaced token keeps the discovered script name.
		const replaced = await connect();
		expect(replaced.workerScriptName).toBe("my-mail");
		expect(replaced.updatedAt).toBeGreaterThan(patched.updatedAt);

		expect(cf.delete()).toBe(true);
		expect(cf.get()).toBeNull();
		expect(cf.delete()).toBe(false);
		expect(cf.update({ verifiedAt: 1 }, now)).toBeNull();
	});

	it("fails to open with another key", async () => {
		const enc = await sealCloudflareToken(TOKEN, SECRET);
		await expect(openCloudflareToken(enc, "other-secret")).rejects.toThrow();
	});
});

describe("resolveCloudflareToken", () => {
	it("CF_API_TOKEN env wins and the AuthDO is not read", async () => {
		await connect();
		const r = await resolveCloudflareToken(env({ CF_API_TOKEN: " env-token ", CF_ACCOUNT_ID: "envacc" }), rpc);
		expect(r).toEqual({ token: "env-token", accountId: "envacc", source: "env", workerScriptName: null });
		expect(reads).toBe(0);
	});

	it("falls back to the stored connection", async () => {
		await connect();
		const r = await resolveCloudflareToken(env(), rpc);
		expect(r).toMatchObject({ token: TOKEN, accountId: "acc1", source: "connection" });
	});

	it("is null with neither, and when the AuthDO is missing or old", async () => {
		expect(await resolveCloudflareToken(env(), rpc)).toBeNull();
		invalidateCloudflareConnectionCache();
		expect(await resolveCloudflareToken(env())).toBeNull();
		invalidateCloudflareConnectionCache();
		const old = { getOrInitMeta: rpc.getOrInitMeta, getCloudflareConnection: async () => { throw new Error("no such method"); } };
		expect(await resolveCloudflareToken(env(), old)).toBeNull();
	});

	it("reports reconnect_required instead of throwing when AUTH_SECRET changed", async () => {
		await connect();
		const loaded = await loadCloudflareConnection(env({ AUTH_SECRET: "a-different-secret-value" }), rpc);
		expect(loaded.state).toBe("reconnect_required");
		expect(loaded.resolved).toBeNull();
		expect(loaded.record?.last4).toBe("WXYZ");
		invalidateCloudflareConnectionCache();
		expect(await cloudflareClient(env({ AUTH_SECRET: "a-different-secret-value" }), rpc)).toBeNull();
	});

	it("caches for at most 30 s, so a delete elsewhere takes effect within that", async () => {
		await connect();
		expect((await resolveCloudflareToken(env(), rpc))?.token).toBe(TOKEN);
		cf.delete(); // another isolate disconnected
		now += CONNECTION_CACHE_MS - 1;
		expect((await resolveCloudflareToken(env(), rpc))?.token).toBe(TOKEN);
		expect(reads).toBe(1);
		now += 2;
		expect(await resolveCloudflareToken(env(), rpc)).toBeNull();
		expect(reads).toBe(2);
	});

	it("picks up a replaced token when updated_at changes", async () => {
		await connect();
		await resolveCloudflareToken(env(), rpc);
		await connect("fake-cf-token-cccccccccccccccccccccccc");
		now += CONNECTION_CACHE_MS;
		expect((await resolveCloudflareToken(env(), rpc))?.token).toBe("fake-cf-token-cccccccccccccccccccccccc");
	});
});

describe("worker script name", () => {
	it("WORKER_SCRIPT_NAME env wins, then the stored name, then the default", async () => {
		expect(await resolveWorkerScriptName(env(), rpc)).toBe("cloudmail");
		await connect(TOKEN, { workerScriptName: "my-mail" });
		invalidateCloudflareConnectionCache();
		expect(await resolveWorkerScriptName(env(), rpc)).toBe("my-mail");
		expect(await resolveWorkerScriptName(env({ WORKER_SCRIPT_NAME: "env-name" }), rpc)).toBe("env-name");
		const client = await cloudflareClient(env(), rpc);
		expect(client?.workerScriptName).toBe("my-mail");
		expect(client?.accountId).toBe("acc1");
	});

	it("an env-token client keeps the env behaviour exactly", async () => {
		const client = await cloudflareClient(env({ CF_API_TOKEN: "t" }), rpc);
		expect(client?.workerScriptName).toBe("cloudmail");
		expect(client?.accountId).toBeUndefined();
	});
});

describe("analyticsTokens with a connection", () => {
	it("CF_ANALYTICS_TOKEN → connection → EMAIL_ANALYTICS_TOKEN (GraphQL only)", () => {
		expect(analyticsTokens({ CF_ANALYTICS_TOKEN: "a", EMAIL_ANALYTICS_TOKEN: "b" }, "conn")).toEqual({ graphql: "a", rest: "a" });
		expect(analyticsTokens({ EMAIL_ANALYTICS_TOKEN: "b" }, "conn")).toEqual({ graphql: "conn", rest: "conn" });
		expect(analyticsTokens({ EMAIL_ANALYTICS_TOKEN: "b" }, null)).toEqual({ graphql: "b", rest: null });
	});
});
