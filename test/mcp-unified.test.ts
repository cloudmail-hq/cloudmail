// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * MCP `list_emails` with `mailboxId: "*"` and `list_products`, run through
 * the real `EmailMCP.init()` registrations.
 *
 * `McpAgent` needs a Durable Object runtime, so it is mocked; the server is
 * replaced with a recorder that keeps each tool's handler, and `caller` is
 * pointed at a fixed principal so the handlers run exactly as in production
 * from that point on (readableMailboxes → visibleMailboxes + canDo(read)).
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { DomainStore } from "../workers/lib/domain-store";
import { ProductStore } from "../workers/lib/product-store";
import { applyTokenRestriction, decidePrincipal, type Principal } from "../workers/lib/authz";
import { UNIFIED_MAILBOX_CAP } from "../shared/products";

vi.mock("agents/mcp", () => ({ McpAgent: class {} }));
const { EmailMCP } = await import("../workers/mcp/index");

function sqlite(): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	const db = new DatabaseSync(":memory:");
	return {
		sql: {
			exec: (q: string, ...b: unknown[]) => {
				const rows = db.prepare(q).all(...(b as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx: (fn) => {
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

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function setup(mailboxes: Record<string, { id: string; date: string }[]>) {
	const { sql, tx } = sqlite();
	const auth = new AuthStore(sql, tx);
	const domains = new DomainStore(sql, tx);
	const products = new ProductStore(sql, tx);
	domains.seedDomains([{ domain: "acme.com", name: "acme.com" }, { domain: "beta.io", name: "beta.io" }], 1);
	const rpc = new Proxy(
		{},
		{
			get: (_t, name: string) => async (...args: unknown[]) => {
				if (name === "ensureAndListProducts") {
					return products.ensureDefaultProducts(domains.listDomains().map((d) => ({ hostname: d.hostname })), 1);
				}
				const target = name in products ? products : name in domains ? domains : auth;
				return (target as any)[name](...args);
			},
		},
	);
	const objects = new Map(Object.keys(mailboxes).map((m) => [`mailboxes/${m}.json`, "{}"]));
	const calls: string[] = [];
	const env = {
		ADMIN_EMAILS: "o@example.com",
		DOMAINS: "acme.com,beta.io",
		AUTH_STORE: { idFromName: () => "global", get: () => rpc },
		BUCKET: {
			head: async (k: string) => (objects.has(k) ? {} : null),
			get: async (k: string) => (objects.has(k) ? { json: async () => ({}) } : null),
			list: async ({ prefix }: { prefix?: string }) => ({
				objects: [...objects.keys()].filter((k) => k.startsWith(prefix ?? "")).map((key) => ({ key })),
				truncated: false,
			}),
		},
		MAILBOX: {
			idFromName: (n: string) => n,
			get: (id: string) => ({
				getUnifiedPage: async (o: { limit: number; after?: { date: string; id: string } | null }) => {
					calls.push(id);
					const rows = (mailboxes[id] ?? [])
						.filter((r) => !o.after || r.date < o.after.date || (r.date === o.after.date && r.id < o.after.id))
						.sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1))
						.slice(0, o.limit + 1)
						.map((r) => ({ ...r, subject: r.id, sender: "s@x.com", read: 0, folder_id: "inbox" }));
					return { rows, unread: rows.length };
				},
			}),
		},
	};

	const tools = new Map<string, Handler>();
	const mcp = Object.create(EmailMCP.prototype) as any;
	mcp.env = env;
	mcp.server = {
		tool: (name: string, ...rest: unknown[]) => tools.set(name, rest[rest.length - 1] as Handler),
		prompt: () => {},
		resource: () => {},
		registerTool: () => {},
	};
	let principal: Principal;
	mcp.caller = () => ({ ok: true, principal, verifyMailbox: mcp.gateFor(principal) });
	return {
		calls,
		tools,
		as(p: Principal) {
			principal = p;
		},
		async init() {
			await mcp.init();
		},
	};
}

function admin(): Principal {
	return decidePrincipal({ adminEmails: ["o@example.com"], identity: { kind: "user", id: "o@example.com", subject: null } });
}

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

describe('MCP list_emails mailboxId "*"', () => {
	const MAIL = {
		"support@acme.com": [{ id: "a1", date: "2026-10-05" }, { id: "a2", date: "2026-10-01" }],
		"hello@beta.io": [{ id: "b1", date: "2026-10-03" }],
	};

	it("merges every readable mailbox with mailboxId and product on each row", async () => {
		const h = setup(MAIL);
		await h.init();
		h.as(admin());
		const out = parse(await h.tools.get("list_emails")!({ mailboxId: "*", folder: "inbox", limit: 10, page: 1 }, {}));
		expect(out.emails.map((e: any) => [e.mailboxId, e.id])).toEqual([
			["support@acme.com", "a1"],
			["hello@beta.io", "b1"],
			["support@acme.com", "a2"],
		]);
		expect(out.emails[0].product).toMatchObject({ name: "Acme" });
		expect(out.next_cursor).toBeNull();
		expect(out.unread).toBe(3);
	});

	it("pages with next_cursor", async () => {
		const h = setup(MAIL);
		await h.init();
		h.as(admin());
		const list = h.tools.get("list_emails")!;
		const first = parse(await list({ mailboxId: "*", folder: "inbox", limit: 2, page: 1 }, {}));
		expect(first.emails.map((e: any) => e.id)).toEqual(["a1", "b1"]);
		const second = parse(await list({ mailboxId: "*", folder: "inbox", limit: 2, page: 1, cursor: first.next_cursor }, {}));
		expect(second.emails.map((e: any) => e.id)).toEqual(["a2"]);
		expect(second.next_cursor).toBeNull();
		const bad = await list({ mailboxId: "*", folder: "inbox", limit: 2, page: 1, cursor: "junk!!" }, {});
		expect(bad.isError).toBe(true);
	});

	it("respects a mailbox-limited token: only its mailboxes are queried", async () => {
		const h = setup(MAIL);
		await h.init();
		h.as(applyTokenRestriction(admin(), { id: "t", scopes: ["mail:read"], mailboxes: ["hello@beta.io"] }));
		const out = parse(await h.tools.get("list_emails")!({ mailboxId: "*", folder: "inbox", limit: 10, page: 1 }, {}));
		expect(out.mailboxes).toEqual(["hello@beta.io"]);
		expect(h.calls).toEqual(["hello@beta.io"]);
	});

	it("excludes mailboxes a token cannot read", async () => {
		const h = setup(MAIL);
		await h.init();
		h.as(applyTokenRestriction(admin(), { id: "t", scopes: ["mail:send"], mailboxes: null }));
		const out = parse(await h.tools.get("list_emails")!({ mailboxId: "*", folder: "inbox", limit: 10, page: 1 }, {}));
		expect(out.emails).toEqual([]);
		expect(h.calls).toEqual([]);
	});

	it(`caps at ${UNIFIED_MAILBOX_CAP} mailboxes and names the rest`, async () => {
		const many: Record<string, { id: string; date: string }[]> = {};
		for (let i = 0; i < UNIFIED_MAILBOX_CAP + 3; i++) many[`m${String(i).padStart(2, "0")}@acme.com`] = [{ id: `r${i}`, date: "2026-10-01" }];
		const h = setup(many);
		await h.init();
		h.as(admin());
		const out = parse(await h.tools.get("list_emails")!({ mailboxId: "*", folder: "inbox", limit: 100, page: 1 }, {}));
		expect(out.mailboxes).toHaveLength(UNIFIED_MAILBOX_CAP);
		expect(out.truncated).toHaveLength(3);
		expect(h.calls).toHaveLength(UNIFIED_MAILBOX_CAP);
	});

	it("narrows by product", async () => {
		const h = setup(MAIL);
		await h.init();
		h.as(admin());
		const products = parse(await h.tools.get("list_products")!({}, {})).products;
		const beta = products.find((p: any) => p.domains.includes("beta.io"));
		expect(beta.mailboxes).toEqual(["hello@beta.io"]);
		const out = parse(await h.tools.get("list_emails")!({ mailboxId: "*", folder: "inbox", limit: 10, page: 1, product: [beta.id] }, {}));
		expect(out.emails.map((e: any) => e.id)).toEqual(["b1"]);
	});
});
