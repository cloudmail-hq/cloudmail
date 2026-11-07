// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared harness for the bring-your-own AI gateway route and end-to-end
 * tests: the real Hono app behind an outer app that sets the caller, an R2
 * fake with etags and `onlyIf` preconditions, and a real AuthStore /
 * UsageStore on node:sqlite behind AUTH_STORE (idempotency RPCs routed to
 * the store functions the AuthDO uses).
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { vi } from "vitest";
import { app } from "../../../workers/index";
import { AuthStore, type AuthSql } from "../../../workers/auth/store-core";
import { UsageStore } from "../../../workers/lib/usage-store";
import { DomainStore } from "../../../workers/lib/domain-store";
import { beginIdempotent, completeIdempotent, releaseIdempotent } from "../../../workers/lib/idempotency-store";
import type { AiUsageEntry } from "../../../workers/lib/ai-usage";

export const ADMIN = "owner@example.com";
export const MEMBER = "member@example.com";
export const SUPPORT = "support@example.com";
export const AUTH_SECRET = "test-auth-secret-synthetic";

export interface R2Object {
	body: string;
	etag: string;
}

/** An R2 fake: etags, `onlyIf` preconditions, and a switch to lose the next N races. */
export function r2Fake() {
	const store = new Map<string, R2Object>();
	let version = 0;
	const state = { loseRaces: 0, puts: [] as string[] };
	const bucket = {
		store,
		state,
		head: async (key: string) => (store.has(key) ? { key, etag: store.get(key)!.etag } : null),
		get: async (key: string) => {
			const o = store.get(key);
			if (!o) return null;
			return { key, etag: o.etag, json: async () => JSON.parse(o.body), text: async () => o.body };
		},
		put: async (key: string, value: string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
			const cur = store.get(key);
			const only = opts?.onlyIf;
			if (only) {
				if (state.loseRaces > 0) {
					state.loseRaces--;
					return null;
				}
				if (only.etagMatches !== undefined && cur?.etag !== only.etagMatches) return null;
				if (only.etagDoesNotMatch === "*" && cur) return null;
			}
			const etag = `e${++version}`;
			store.set(key, { body: String(value), etag });
			state.puts.push(key);
			return { key, etag };
		},
		delete: async (key: string) => void store.delete(key),
		list: async (opts: { prefix?: string } = {}) => ({
			objects: [...store.keys()].filter((k) => k.startsWith(opts?.prefix ?? "")).map((key) => ({ key })),
			truncated: false,
		}),
	};
	return bucket;
}
export type R2Fake = ReturnType<typeof r2Fake>;

/** Read, change and write a JSON object in the fake directly (bypassing the routes). */
export function mutateJson(bucket: R2Fake, key: string, fn: (v: any) => void): void {
	const o = bucket.store.get(key);
	if (!o) throw new Error(`no ${key}`);
	const v = JSON.parse(o.body);
	fn(v);
	bucket.store.set(key, { body: JSON.stringify(v), etag: `${o.etag}x` });
}

export function sqliteStores() {
	const db = new DatabaseSync(":memory:");
	const sql: AuthSql = {
		exec(query: string, ...bindings: unknown[]) {
			const rows = db.prepare(query).all(...(bindings as never[])) as any[];
			return { toArray: () => rows };
		},
	};
	const tx = <T>(fn: () => T): T => {
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
	};
	const auth = new AuthStore(sql, tx);
	const usage = new UsageStore(sql, tx);
	const domains = new DomainStore(sql, tx);
	return { db, sql, auth, usage, domains };
}

export function makeHarness() {
	const { sql, auth, usage, domains } = sqliteStores();
	const bucket = r2Fake();
	bucket.store.set(
		`access/users/${MEMBER}.json`,
		{ body: JSON.stringify({ id: MEMBER, role: "member", mailboxes: [{ id: SUPPORT, role: "viewer" }] }), etag: "m" },
	);
	const usageEntries: AiUsageEntry[] = [];
	const rpc = new Proxy(
		{},
		{
			get: (_t, name: string) => {
				if (name === "then") return undefined;
				return async (...args: any[]) => {
					const api: Record<string, (...a: any[]) => unknown> = {
						idempotencyBegin: (i) => beginIdempotent(sql, i),
						idempotencyComplete: (i) => completeIdempotent(sql, i),
						idempotencyRelease: (i) => releaseIdempotent(sql, i),
						recordAiCall: (f: never, d: string, n?: number) => usage.recordAiCall(f, d, n),
						recordAiUsage: (e: AiUsageEntry) => {
							usageEntries.push(e);
							return usage.recordAiUsage(e);
						},
						aiUsage: (f: string, t: string) => usage.aiCalls(f, t),
					};
					if (name in api) return api[name]!(...args);
					const target = name in domains ? domains : auth;
					return (target as any)[name](...args);
				};
			},
		},
	);
	const ai = { run: vi.fn(async (_model: string, _input: unknown) => ({ response: "NO" })) };
	const env = {
		AUTH_MODE: "access",
		ADMIN_EMAILS: ADMIN,
		DOMAINS: "example.com",
		EMAIL_ADDRESSES: [],
		AUTH_SECRET,
		AUTH_STORE: { idFromName: () => "global", get: () => rpc },
		BUCKET: bucket,
		AI: ai,
		MAILBOX: { idFromName: (n: string) => n, get: () => ({}) },
	} as Record<string, unknown>;
	return { env, bucket, auth, usage, usageEntries, ai };
}

export const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

export type Caller =
	| { kind: "access" }
	| { kind: "session" }
	| { kind: "token"; scopes: string[] | null }
	| { kind: "oauth" };

/** A fetch against the real app as `identity`, authenticated the way `caller` says. */
export function as(identity: string, env: Record<string, unknown>, caller: Caller = { kind: "access" }) {
	const outer = new Hono();
	outer.use("*", async (c, next) => {
		(c as any).set("accessIdentity", { kind: "user", id: identity, subject: `s-${identity}` });
		if (caller.kind === "session") (c as any).set("authMethod", "session");
		if (caller.kind === "oauth") (c as any).set("authMethod", "oauth");
		if (caller.kind === "token") {
			(c as any).set("authMethod", "token");
			(c as any).set("authToken", {
				id: "tok",
				userId: "u",
				name: "t",
				createdAt: 0,
				lastUsedAt: null,
				lastUsedIp: null,
				expiresAt: null,
				scopes: caller.scopes,
				mailboxes: null,
				parentId: null,
			});
		}
		return next();
	});
	outer.route("/", app as never);
	return async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
		const res = await outer.fetch(
			new Request(`https://mailer.example.com${path}`, {
				method: init.method ?? "GET",
				body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
				headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...(init.headers ?? {}) },
			}),
			env,
			ctx,
		);
		// Audit writes are deferred; let them land.
		await new Promise((r) => setTimeout(r, 0));
		return res;
	};
}

export async function json<T = any>(res: Response): Promise<T> {
	const text = await res.text();
	return (text ? JSON.parse(text) : null) as T;
}
