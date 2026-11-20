// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Idempotency keys (`Idempotency-Key` header and MCP `idempotency_key`).
 *
 * The store runs against node:sqlite through the same SQL the Durable Objects
 * run. The middleware is driven through a real Hono app whose backend is that
 * store wrapped in a serialising queue, the way a Durable Object serialises
 * RPCs. The real `app` from workers/index.ts is used to check the mounts.
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	IDEMPOTENCY_ERROR,
	IDEMPOTENT_REPLAYED_HEADER,
	INSTANCE_IDEMPOTENT_ROUTES,
	MAILBOX_IDEMPOTENT_ROUTES,
	canonicalJson,
	idempotency,
	isStorableStatus,
	isValidIdempotencyKey,
	principalKeyOf,
	redactSecret,
	runIdempotentTool,
	type IdempotencyBackend,
	type McpToolResult,
} from "../workers/lib/idempotency";
import {
	IDEMPOTENCY_INDEX_SQL,
	IDEMPOTENCY_IN_FLIGHT_MS,
	IDEMPOTENCY_TABLE_SQL,
	IDEMPOTENCY_TTL_MS,
	beginIdempotent,
	completeIdempotent,
	releaseIdempotent,
	sweepIdempotencyKeys,
	type IdempotencySql,
} from "../workers/lib/idempotency-store";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { AUTH_MIGRATION_NAMES } from "../workers/auth/store-core";
import { openApiDocument, type OperationObject, type ParameterObject } from "../workers/lib/openapi";
import type { Principal } from "../workers/lib/authz";

// ── Harness ─────────────────────────────────────────────────────────

function sqlOver(db: DatabaseSync): IdempotencySql {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const rows = db.prepare(query).all(...(bindings as never[])) as any[];
			return { toArray: () => rows };
		},
	};
}

/** A fresh store plus a backend that serialises calls like a Durable Object. */
function harness(clock: { now: number } = { now: Date.UTC(2026, 9, 26) }) {
	const db = new DatabaseSync(":memory:");
	db.exec(IDEMPOTENCY_TABLE_SQL);
	db.exec(IDEMPOTENCY_INDEX_SQL);
	const sql = sqlOver(db);
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => T): Promise<T> => {
		const run = queue.then(fn);
		queue = run.catch(() => undefined);
		return run;
	};
	const backend: IdempotencyBackend = {
		idempotencyBegin: (input) => serial(() => beginIdempotent(sql, { ...input, now: clock.now })),
		idempotencyComplete: (input) => serial(() => completeIdempotent(sql, { ...input, now: clock.now })),
		idempotencyRelease: (input) => serial(() => releaseIdempotent(sql, input)),
	};
	return { db, sql, backend, clock };
}

const principal = (id: string, tokenId: string | null = null): Principal =>
	({
		identity: { kind: "user", id, subject: `sub-${id}` },
		role: "admin",
		mailboxes: null,
		access: null,
		enforced: true,
		developmentBypass: false,
		token: tokenId ? { id: tokenId, scopes: [], mailboxes: null } : null,
	}) as Principal;

/**
 * A Hono app with the middleware on a "send" route whose handler counts its
 * runs. `respond` decides each answer; `gate` lets a test hold a run open.
 */
function sendApp(
	backend: IdempotencyBackend,
	respond: (n: number) => Response | Promise<Response> = (n) =>
		Response.json({ id: `msg-${n}`, status: "sent" }, { status: 202 }),
) {
	const app = new Hono<any>();
	let runs = 0;
	app.use("*", async (c, next) => {
		const who = c.req.header("X-Test-User") ?? "alice";
		const token = c.req.header("X-Test-Token") ?? null;
		c.set("principal", principal(who, token));
		return next();
	});
	app.on(
		["POST"],
		"/api/v1/mailboxes/:mailboxId/emails",
		idempotency({ route: "POST /api/v1/mailboxes/:mailboxId/emails", backend: () => backend }),
	);
	app.post("/api/v1/mailboxes/:mailboxId/emails", async (c) => {
		runs += 1;
		await c.req.json(); // the handler can still read the body
		return respond(runs);
	});
	app.onError((_e, c) => c.json({ error: "Internal" }, 500));
	const send = (body: unknown, headers: Record<string, string> = {}, mailbox = "support@example.com") =>
		app.request(`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/emails`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	return { app, send, runs: () => runs };
}

const KEY = { "Idempotency-Key": "order-1234-confirmation" };
const MAIL = { to: "customer@example.org", subject: "Your order", html: "<p>Thanks</p>" };

// ── REST middleware ─────────────────────────────────────────────────

describe("Idempotency-Key middleware", () => {
	it("replays the stored response for a repeat with the same payload", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend);

		const first = await send(MAIL, KEY);
		expect(first.status).toBe(202);
		expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
		const firstBody = await first.json();

		// Same payload, keys in a different order: still the same request.
		const again = await send({ html: MAIL.html, subject: MAIL.subject, to: MAIL.to }, KEY);
		expect(again.status).toBe(202);
		expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
		expect(again.headers.get("Content-Type")).toContain("application/json");
		expect(await again.json()).toEqual(firstBody);
		expect(runs()).toBe(1);
	});

	it("does nothing without the header", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend);
		await send(MAIL);
		await send(MAIL);
		expect(runs()).toBe(2);
	});

	it("refuses the same key with a different payload", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend);
		await send(MAIL, KEY);
		const res = await send({ ...MAIL, subject: "Something else" }, KEY);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe(IDEMPOTENCY_ERROR.reused);
		expect(runs()).toBe(1);
	});

	it("treats the same key on another mailbox as a different payload", async () => {
		const { backend } = harness();
		const { send } = sendApp(backend);
		await send(MAIL, KEY, "support@example.com");
		const res = await send(MAIL, KEY, "sales@example.com");
		expect(res.status).toBe(409);
	});

	it("refuses a concurrent duplicate while the first is in flight", async () => {
		const { backend } = harness();
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const { send, runs } = sendApp(backend, async (n) => {
			await held;
			return Response.json({ id: `msg-${n}` }, { status: 202 });
		});

		const first = send(MAIL, KEY);
		// Let the first request reserve the key before the duplicate arrives.
		await new Promise((r) => setTimeout(r, 10));
		const dup = await send(MAIL, KEY);
		expect(dup.status).toBe(409);
		expect(dup.headers.get("Retry-After")).toBe("1");
		expect((await dup.json()).code).toBe(IDEMPOTENCY_ERROR.inProgress);

		release();
		expect((await first).status).toBe(202);
		const after = await send(MAIL, KEY);
		expect(after.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
		expect(runs()).toBe(1);
	});

	it("does not store a 5xx, so a retry runs again", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend, (n) =>
			n === 1 ? Response.json({ error: "provider down" }, { status: 502 }) : Response.json({ id: "ok" }, { status: 202 }),
		);
		expect((await send(MAIL, KEY)).status).toBe(502);
		const retry = await send(MAIL, KEY);
		expect(retry.status).toBe(202);
		expect(retry.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
		expect(runs()).toBe(2);
	});

	it("does not store a thrown handler (Hono's 500), so a retry runs again", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend, (n) => {
			if (n === 1) throw new Error("boom");
			return Response.json({ id: "ok" }, { status: 202 });
		});
		expect((await send(MAIL, KEY)).status).toBe(500);
		expect((await send(MAIL, KEY)).status).toBe(202);
		expect(runs()).toBe(2);
	});

	it("stores a 4xx and replays it, like Resend", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend, () => Response.json({ error: "bad recipient" }, { status: 422 }));
		expect((await send(MAIL, KEY)).status).toBe(422);
		const again = await send(MAIL, KEY);
		expect(again.status).toBe(422);
		expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
		expect(runs()).toBe(1);
	});

	it("does not store a 429", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend, (n) =>
			n === 1 ? Response.json({ error: "quota" }, { status: 429 }) : Response.json({ id: "ok" }, { status: 202 }),
		);
		expect((await send(MAIL, KEY)).status).toBe(429);
		expect((await send(MAIL, KEY)).status).toBe(202);
		expect(runs()).toBe(2);
	});

	it("expires a stored response after 24 hours", async () => {
		const h = harness();
		const { send, runs } = sendApp(h.backend);
		await send(MAIL, KEY);
		h.clock.now += IDEMPOTENCY_TTL_MS - 1000;
		expect((await send(MAIL, KEY)).headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
		h.clock.now += 2000;
		const fresh = await send(MAIL, KEY);
		expect(fresh.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
		expect(runs()).toBe(2);
		// Lazily replaced, and a different payload is now allowed too.
		h.clock.now += IDEMPOTENCY_TTL_MS + 1;
		expect((await send({ ...MAIL, subject: "new" }, KEY)).status).toBe(202);
	});

	it("isolates keys per principal and per API token", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend);
		await send(MAIL, { ...KEY, "X-Test-User": "alice" });
		// Another user, same key and payload: runs, and is not a replay.
		const bob = await send(MAIL, { ...KEY, "X-Test-User": "bob" });
		expect(bob.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
		// The same user through an API token: its own slot.
		const viaToken = await send({ ...MAIL, subject: "different" }, { ...KEY, "X-Test-User": "alice", "X-Test-Token": "tok1" });
		expect(viaToken.status).toBe(202);
		const otherToken = await send(MAIL, { ...KEY, "X-Test-User": "alice", "X-Test-Token": "tok2" });
		expect(otherToken.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
		expect(runs()).toBe(4);
		// And alice's own slot still replays.
		const alice = await send(MAIL, { ...KEY, "X-Test-User": "alice" });
		expect(alice.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
	});

	it("does not key a caller with no identity, so strangers never share a slot", async () => {
		const { backend } = harness();
		const app = new Hono<any>();
		let runs = 0;
		app.use("*", async (c, next) => {
			c.set("principal", { ...principal("x"), identity: null });
			return next();
		});
		app.on(["POST"], "/x", idempotency({ route: "POST /x", backend: () => backend }));
		app.post("/x", (c) => {
			runs += 1;
			return c.json({ n: runs }, 201);
		});
		const post = () => app.request("/x", { method: "POST", headers: KEY, body: "{}" });
		await post();
		const second = await post();
		expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
		expect(runs).toBe(2);
	});

	it("does not pin a 403 to the key", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend, (n) =>
			n === 1 ? Response.json({ error: "no grant" }, { status: 403 }) : Response.json({ id: "ok" }, { status: 202 }),
		);
		expect((await send(MAIL, KEY)).status).toBe(403);
		expect((await send(MAIL, KEY)).status).toBe(202);
		expect(runs()).toBe(2);
	});

	it("treats a different query string as a different request", async () => {
		const { backend } = harness();
		const { app } = sendApp(backend);
		const post = (q: string) =>
			app.request(`/api/v1/mailboxes/support%40example.com/emails${q}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...KEY },
				body: JSON.stringify(MAIL),
			});
		expect((await post("")).status).toBe(202);
		expect((await post("?confirm=1")).status).toBe(409);
	});

	it("rejects an invalid key", async () => {
		const { backend } = harness();
		const { send, runs } = sendApp(backend);
		for (const bad of ["", "x".repeat(257), "café", "tab\there"]) {
			const res = await send(MAIL, { "Idempotency-Key": bad });
			expect(res.status, JSON.stringify(bad)).toBe(400);
			expect((await res.json()).code).toBe(IDEMPOTENCY_ERROR.invalid);
		}
		expect((await send(MAIL, { "Idempotency-Key": "x".repeat(256) })).status).toBe(202);
		expect(runs()).toBe(1);
	});

	it("answers 503 rather than running unguarded when storage fails", async () => {
		const broken: IdempotencyBackend = {
			idempotencyBegin: async () => {
				throw new Error("DO unavailable");
			},
			idempotencyComplete: async () => true,
			idempotencyRelease: async () => undefined,
		};
		const { send, runs } = sendApp(broken);
		const res = await send(MAIL, KEY);
		expect(res.status).toBe(503);
		expect(runs()).toBe(0);
	});
});

// ── Store ───────────────────────────────────────────────────────────

describe("idempotency store", () => {
	const ref = { scope: "u:a|t:-|POST /x", key: "k", requestHash: "h1" };

	it("frees an abandoned in-flight reservation after its timeout", () => {
		const { sql } = harness();
		const t = 1_000_000;
		expect(beginIdempotent(sql, { ...ref, now: t }).state).toBe("started");
		expect(beginIdempotent(sql, { ...ref, now: t + 1000 }).state).toBe("in_progress");
		expect(beginIdempotent(sql, { ...ref, now: t + IDEMPOTENCY_IN_FLIGHT_MS + 1 }).state).toBe("started");
	});

	it("fences a timed-out request off its same-payload successor's row", () => {
		const { sql, db } = harness();
		const first = beginIdempotent(sql, { ...ref, now: 0 });
		if (first.state !== "started") throw new Error("expected started");
		// The first request outlives its reservation; a retry takes the key over.
		const retry = beginIdempotent(sql, { ...ref, now: IDEMPOTENCY_IN_FLIGHT_MS + 1 });
		if (retry.state !== "started") throw new Error("expected started");

		// The late first request can neither complete nor release the retry's row.
		expect(
			completeIdempotent(sql, { ...ref, reservedAt: first.reservedAt, status: 202, body: "{}", contentType: null }),
		).toBe(false);
		releaseIdempotent(sql, { ...ref, reservedAt: first.reservedAt });
		expect(beginIdempotent(sql, { ...ref, now: IDEMPOTENCY_IN_FLIGHT_MS + 2 }).state).toBe("in_progress");

		// The retry itself still can.
		expect(
			completeIdempotent(sql, { ...ref, reservedAt: retry.reservedAt, status: 202, body: "{}", contentType: null, now: IDEMPOTENCY_IN_FLIGHT_MS + 3 }),
		).toBe(true);
		expect((db.prepare("SELECT status FROM idempotency_keys").get() as { status: number }).status).toBe(202);
	});

	it("sweeps expired rows", () => {
		const { sql, db } = harness();
		for (let i = 0; i < 5; i++) {
			const begun = beginIdempotent(sql, { ...ref, key: `k${i}`, now: 0 });
			if (begun.state !== "started") throw new Error("expected started");
			completeIdempotent(sql, { ...ref, key: `k${i}`, reservedAt: begun.reservedAt, status: 200, body: "{}", contentType: null, now: 0 });
		}
		expect(sweepIdempotencyKeys(sql, IDEMPOTENCY_TTL_MS - 1)).toBe(0);
		expect(sweepIdempotencyKeys(sql, IDEMPOTENCY_TTL_MS + 1)).toBe(5);
		expect((db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get() as { n: number }).n).toBe(0);
	});
});

describe("helpers", () => {
	it("canonical JSON ignores key order but not array order", () => {
		expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});

	it("validates keys as 1-256 printable ASCII", () => {
		expect(isValidIdempotencyKey("a")).toBe(true);
		expect(isValidIdempotencyKey("~ !")).toBe(true);
		expect(isValidIdempotencyKey("")).toBe(false);
		expect(isValidIdempotencyKey("\u0000")).toBe(false);
	});

	it("stores 2xx-4xx except 401/403/408/429", () => {
		expect([200, 201, 202, 400, 404, 409, 422].every(isStorableStatus)).toBe(true);
		expect([401, 403, 408, 429, 500, 502, 503].some(isStorableStatus)).toBe(false);
	});

	it("scopes by user and token, and refuses to scope a caller with no identity", () => {
		expect(principalKeyOf(principal("a"))).not.toBe(principalKeyOf(principal("b")));
		expect(principalKeyOf(principal("a", "t1"))).not.toBe(principalKeyOf(principal("a", "t2")));
		expect(principalKeyOf({ ...principal("a"), identity: null } as Principal)).toBeNull();
		expect(principalKeyOf(undefined)).toBeNull();
	});

	it("redacts a token or webhook secret before it is stored", () => {
		const redacted = JSON.parse(redactSecret(JSON.stringify({ token: { id: "abc" }, secret: "ttk_abc_s3cret" })));
		expect(redacted).toEqual({ token: { id: "abc" }, secret: null, secret_redacted: true });
		expect(redactSecret('{"id":"m1"}')).toBe('{"id":"m1"}');
	});
});

// ── MCP ─────────────────────────────────────────────────────────────

describe("MCP idempotency_key", () => {
	const ok = (n: number): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify({ status: "sent", n }) }] });
	const args = { mailboxId: "support@example.com", to: "c@example.org", subject: "Hi", bodyHtml: "<p>x</p>", idempotency_key: "k-1" };

	it("replays a send_email call instead of sending twice", async () => {
		const { backend } = harness();
		let runs = 0;
		const call = (a: Record<string, unknown> & { idempotency_key?: string }) =>
			runIdempotentTool(
				{ backend, principal: principal("alice"), tool: "send_email", key: a.idempotency_key, args: a },
				async () => ok(++runs),
			);
		const first = await call(args);
		const second = await call(args);
		expect(runs).toBe(1);
		expect(second.content[0]).toEqual(first.content[0]);
		expect(JSON.parse(second.content.at(-1)!.text)).toEqual({ idempotent_replayed: true });

		const mismatch = await call({ ...args, subject: "Other" });
		expect(mismatch.isError).toBe(true);
		expect(JSON.parse(mismatch.content[0].text).code).toBe(IDEMPOTENCY_ERROR.reused);

		await call({ ...args, idempotency_key: undefined });
		expect(runs).toBe(2);
	});

	it("releases a tool error so a retry runs again", async () => {
		const { backend } = harness();
		let runs = 0;
		const run = async (): Promise<McpToolResult> =>
			++runs === 1 ? { content: [{ type: "text", text: '{"error":"quota"}' }], isError: true } : ok(runs);
		const call = () => runIdempotentTool({ backend, principal: principal("a"), tool: "send_email", key: "k", args }, run);
		expect((await call()).isError).toBe(true);
		expect((await call()).isError).toBeUndefined();
		expect(runs).toBe(2);
	});

	it("is offered on every send, create and schedule tool", () => {
		const source = readFileSync(new URL("../workers/mcp/index.ts", import.meta.url), "utf8");
		const starts = [...source.matchAll(/this\.server\.tool\(\s*"([a-z_]+)"/g)];
		const blocks = new Map(
			starts.map((m, i) => [m[1]!, source.slice(m.index!, starts[i + 1]?.index ?? source.length)]),
		);
		const expected = [
			"send_email", "send_reply", "forward_email", "schedule_send", "send_template",
			"create_draft", "draft_reply", "create_folder", "create_label", "create_rule",
			"enroll_in_sequence", "create_signature",
		];
		for (const name of expected) {
			const block = blocks.get(name)!;
			expect(block, name).toContain("idempotency_key: idempotencyKeyParam");
			expect(block, name).toContain(`once(who.principal, mailboxId, "${name}"`);
		}
		// Every other send/create/schedule tool is in the list above.
		// `create_agent_inbox` is instance-level (no mailbox to key it under yet);
		// REST `POST /api/v1/agent-inboxes` honours Idempotency-Key instead.
		for (const name of blocks.keys()) {
			if (name === "create_agent_inbox") continue;
			// `create_template` is instance-level too, and a repeat fails as a
			// duplicate slug rather than creating a second template.
			if (name === "create_template") continue;
			if (/^(send_|create_|schedule_)/.test(name)) expect(expected, name).toContain(name);
		}
	});
});

// ── Mounting, migrations, OpenAPI ───────────────────────────────────

describe("wiring", () => {
	it("mounts the middleware on every keyed route of the real app", async () => {
		const { app } = await import("../workers/index");
		const mounted = new Set(
			app.routes
				.filter((r) => r.method === "POST" && r.handler.length >= 2)
				.map((r) => r.path),
		);
		for (const [path] of [...MAILBOX_IDEMPOTENT_ROUTES, ...INSTANCE_IDEMPOTENT_ROUTES]) {
			expect(mounted.has(path), path).toBe(true);
		}
		const appSource = readFileSync(new URL("../workers/app.ts", import.meta.url), "utf8");
		expect(appSource).toContain('app.on(["POST"], "/api/auth/tokens", tokenCreateIdempotency);');
	});

	it("appends the MailboxDO migration after 28 and the AuthDO one after 0008", () => {
		const names = mailboxMigrations.map((m) => m.name);
		expect(names[names.indexOf("28_add_engagement_cache") + 1]).toBe("29_add_idempotency_keys");
		expect(AUTH_MIGRATION_NAMES[AUTH_MIGRATION_NAMES.indexOf("0008_suppressions") + 1]).toBe("0009_idempotency_keys");
	});

	it("the MailboxDO migration creates a table the store can use", () => {
		const db = new DatabaseSync(":memory:");
		const exec = (query: string, ...bindings: unknown[]) => {
			const trimmed = query.trim();
			if (/^(select|with)/i.test(trimmed)) {
				const rows = db.prepare(trimmed).all(...(bindings as never[])) as any[];
				return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
			}
			if (bindings.length === 0) {
				db.exec(trimmed);
				return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
			}
			db.prepare(trimmed).run(...(bindings as never[]));
			return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
		};
		applyMigrations({ exec } as unknown as SqlStorage, mailboxMigrations, { transactionSync: (fn: () => unknown) => fn() } as never);
		const sql = sqlOver(db);
		expect(beginIdempotent(sql, { scope: "s", key: "k", requestHash: "h" }).state).toBe("started");
	});

	it("documents the header and 409s on every keyed operation", () => {
		const keyed: Array<[string, string]> = [
			...[...MAILBOX_IDEMPOTENT_ROUTES, ...INSTANCE_IDEMPOTENT_ROUTES].map(
				([p]) => ["post", p.replace(/:([A-Za-z0-9_]+)/g, "{$1}")] as [string, string],
			),
		];
		for (const [method, path] of keyed) {
			const op = (openApiDocument.paths[path] as Record<string, OperationObject> | undefined)?.[method];
			expect(op, path).toBeDefined();
			const header = (op!.parameters ?? []).find(
				(p) => (p as ParameterObject).in === "header" && (p as ParameterObject).name === "Idempotency-Key",
			) as ParameterObject | undefined;
			expect(header, path).toBeDefined();
			expect(header!.schema.maxLength).toBe(256);
			expect(op!.responses["409"], path).toBeDefined();
		}
		expect(JSON.stringify(openApiDocument.components.responses.IdempotencyConflict)).toContain(
			"idempotency_request_in_progress",
		);
	});
});
