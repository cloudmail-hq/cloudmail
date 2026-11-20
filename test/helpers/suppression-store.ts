// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A real `AuthStore` over in-memory `node:sqlite`, exposed as the
 * `AUTH_STORE` namespace shape the Worker code reaches for. Suppression
 * semantics (unique per address+scope, scope matching, LIKE escaping) are
 * query semantics, so tests run them against SQLite rather than a fake.
 */

import { DatabaseSync } from "node:sqlite";
import { AuthStore, type AuthSql } from "../../workers/auth/store-core";

export function sqliteAuthStore(): AuthStore {
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
	return new AuthStore(sql, tx);
}

/** `{ AUTH_STORE }` for an env literal, backed by `store`. */
export function authStoreBinding(store: AuthStore = sqliteAuthStore()) {
	return {
		store,
		AUTH_STORE: {
			idFromName: (name: string) => name,
			get: () => store,
		},
	};
}

/** In-memory R2 stand-in with the subset the sequence store uses. */
export function fakeBucket() {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			const value = store.get(key);
			if (value === undefined) return null;
			return { json: async <T>() => JSON.parse(value) as T, text: async () => value };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async head(key: string) {
			return store.has(key) ? {} : null;
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
				truncated: false,
			};
		},
	};
}
