// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The realtime event stream.
 *
 * `EventsHub` (the logic inside EventsDO) runs on node:sqlite with mocked
 * hibernatable WebSockets: `acceptWebSocket`, `getWebSockets(tag)` and
 * attachment serialisation behave as the runtime's do. The Worker route is
 * driven through the real app with a fake EVENTS namespace that captures what
 * the object would receive.
 *
 * Covers auth, mail:read, subscribe filtering, the authorization filter,
 * `since` cursor replay (and expiry), connection caps, backpressure, SSE, and
 * the MailboxDO ledger feeding the stream from its own cursor.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../workers/index";
import {
	CLOSE_REAUTHENTICATE,
	CLOSE_SLOW_CONSUMER,
	EVENT_RETENTION_MS,
	EventsHub,
	MAX_BUFFERED_BYTES,
	MAX_CONNECTIONS_PER_PRINCIPAL,
	SEND_BURST,
	matches,
	parseCursor,
	parseSubscribe,
	type ConnectionGrant,
	type HubSocket,
	type SseClient,
} from "../workers/lib/events-hub";
import { EVENTS_GRANT_HEADER, decodeGrant, readableMailboxes } from "../workers/lib/events";
import { STREAM_CURSOR_KEY, flushLedgerToWebhooks } from "../workers/durableObject/webhook-events";
import { applyTokenRestriction, decidePrincipal } from "../workers/lib/authz";
import type { EnqueueInput } from "../workers/lib/webhooks-store";
import type { WebhookEventType } from "../shared/webhooks";

// ── Mock hibernation API ────────────────────────────────────────────

class FakeSocket implements HubSocket {
	sent: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	bufferedAmount = 0;
	private attachment: unknown = null;
	send(data: string) {
		if (this.closed) throw new Error("closed");
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		this.closed = { code, reason };
	}
	serializeAttachment(v: unknown) {
		// The runtime structured-clones; JSON is close enough and catches non-cloneables.
		this.attachment = JSON.parse(JSON.stringify(v));
	}
	deserializeAttachment() {
		return this.attachment;
	}
	messages() {
		return this.sent.map((s) => JSON.parse(s));
	}
	events() {
		return this.messages().filter((m) => m.type === "event");
	}
}

function hubOver() {
	const db = new DatabaseSync(":memory:");
	const sockets: { ws: FakeSocket; tags: string[] }[] = [];
	const hub = new EventsHub({
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const rows = db.prepare(query).all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		acceptWebSocket: (ws, tags) => void sockets.push({ ws: ws as FakeSocket, tags }),
		getWebSockets: (tag) => sockets.filter((s) => !s.ws.closed && (!tag || s.tags.includes(tag))).map((s) => s.ws),
	});
	return { hub, sockets, db };
}

const NOW = Date.UTC(2026, 9, 26, 12);
const grant = (readable: string[] | null, key = "p:alice@example.com", expiresAt = NOW + 3600_000): ConnectionGrant => ({ key, readable, expiresAt });

let seq = 0;
function event(mailbox: string, type: WebhookEventType = "message.received"): EnqueueInput {
	seq += 1;
	const eventId = `evt_${mailbox}_${seq}`;
	return { eventId, type, mailbox, payload: JSON.stringify({ id: eventId, type, mailbox, data: { n: seq } }), now: NOW };
}

function connect(hub: EventsHub, g: ConnectionGrant, since: number | null = null) {
	const ws = new FakeSocket();
	expect(hub.admit(g)).toEqual({ ok: true });
	hub.acceptSocket(ws, g, since);
	return ws;
}

function subscribe(hub: EventsHub, ws: FakeSocket, body: Record<string, unknown> = {}, now = NOW) {
	hub.onMessage(ws, JSON.stringify({ type: "subscribe", ...body }), now);
}

beforeEach(() => {
	seq = 0;
});

// ── Pure ────────────────────────────────────────────────────────────

describe("subscribe parsing and matching", () => {
	it("drops mailboxes the grant does not cover and reports them", () => {
		const parsed = parseSubscribe(grant(["a@x.com"]), { mailboxes: ["A@x.com", "b@x.com"], events: ["message.sent"] });
		expect(parsed).toEqual({ ok: true, subscription: { mailboxes: ["a@x.com"], events: ["message.sent"] }, denied: ["b@x.com"], since: null });
	});

	it("never widens: only unreadable mailboxes means none", () => {
		const parsed = parseSubscribe(grant(["a@x.com"]), { mailboxes: ["b@x.com"] });
		expect(parsed.ok && parsed.subscription.mailboxes).toEqual([]);
		expect(matches(grant(["a@x.com"]), { mailboxes: [], events: null }, { mailbox: "a@x.com", type: "message.sent" })).toBe(false);
	});

	it("rejects unknown event types and bad cursors", () => {
		expect(parseSubscribe(grant(null), { events: ["message.nope"] }).ok).toBe(false);
		expect(parseSubscribe(grant(null), { since: -1 }).ok).toBe(false);
		expect(parseCursor("42")).toBe(42);
		expect(parseCursor("x")).toBeNull();
		expect(parseCursor(undefined)).toBeNull();
	});

	it("filters by the grant even with a match-all subscription", () => {
		const g = grant(["a@x.com"]);
		expect(matches(g, { mailboxes: null, events: null }, { mailbox: "b@x.com", type: "message.sent" })).toBe(false);
		expect(matches(g, { mailboxes: null, events: null }, { mailbox: "A@x.com", type: "message.sent" })).toBe(true);
	});
});

// ── Hub ─────────────────────────────────────────────────────────────

describe("EventsHub over hibernatable sockets", () => {
	it("says hello, then delivers only subscribed events with the webhook payload", () => {
		const { hub } = hubOver();
		const ws = connect(hub, grant(null));
		expect(ws.messages()[0]).toMatchObject({ type: "hello", latest_id: 0, readable: "all" });
		// Nothing before subscribe.
		hub.publish([event("a@x.com")], NOW);
		expect(ws.events()).toEqual([]);

		subscribe(hub, ws, { mailboxes: ["a@x.com"], events: ["message.sent"] });
		hub.publish([event("a@x.com", "message.received"), event("a@x.com", "message.sent"), event("b@x.com", "message.sent")], NOW);
		const got = ws.events();
		expect(got).toHaveLength(1);
		expect(got[0].event).toMatchObject({ type: "message.sent", mailbox: "a@x.com" });
		expect(got[0].id).toBe(3);
	});

	it("never sends a mailbox outside the grant, whatever was asked for", () => {
		const { hub } = hubOver();
		const ws = connect(hub, grant(["a@x.com"]));
		subscribe(hub, ws, {});
		const reply = ws.messages().find((m) => m.type === "subscribed");
		expect(reply).toMatchObject({ mailboxes: "all", denied: [] });
		hub.publish([event("a@x.com"), event("secret@x.com")], NOW);
		expect(ws.events().map((e) => e.event.mailbox)).toEqual(["a@x.com"]);

		const other = connect(hub, grant(["a@x.com"], "p:bob"));
		subscribe(hub, other, { mailboxes: ["secret@x.com"] });
		expect(other.messages().find((m) => m.type === "subscribed").denied).toEqual(["secret@x.com"]);
		hub.publish([event("secret@x.com")], NOW);
		expect(other.events()).toEqual([]);
	});

	it("survives hibernation: the subscription lives in the attachment", () => {
		const { hub, sockets, db } = hubOver();
		const ws = connect(hub, grant(null));
		subscribe(hub, ws, { mailboxes: ["a@x.com"] });
		// A woken object: new hub, same storage, same sockets.
		const woken = new EventsHub({
			sql: { exec: (q: string, ...b: unknown[]) => ({ toArray: () => db.prepare(q).all(...(b as never[])) as any[] }) },
			acceptWebSocket: () => undefined,
			getWebSockets: () => sockets.map((s) => s.ws),
		});
		woken.publish([event("a@x.com")], NOW);
		expect(ws.events()).toHaveLength(1);
	});

	it("replays missed events after ?since, and ids are monotonic", () => {
		const { hub } = hubOver();
		hub.publish([event("a@x.com"), event("b@x.com"), event("a@x.com", "message.sent")], NOW);
		expect(hub.latestId()).toBe(3);

		const ws = connect(hub, grant(["a@x.com"]), 1);
		subscribe(hub, ws, {});
		expect(ws.events().map((e) => e.id)).toEqual([3]);
		expect(ws.messages().at(-1)).toMatchObject({ type: "replayed", count: 1, latest_id: 3 });

		// A cursor in the subscribe message works too.
		const again = connect(hub, grant(null, "p:bob"));
		subscribe(hub, again, { since: 0 });
		expect(again.events().map((e) => e.id)).toEqual([1, 2, 3]);

		// Duplicate event ids are not stored or sent twice.
		expect(hub.publish([{ ...event("a@x.com"), eventId: "evt_a@x.com_1" }], NOW)).toBe(0);
		expect(hub.eventsAfter(0, 100)).toHaveLength(3);
		expect(again.events()).toHaveLength(3);
	});

	it("keeps 24 hours and says when a cursor is older than that", () => {
		const { hub } = hubOver();
		hub.publish([event("a@x.com"), event("a@x.com")], NOW);
		const later = NOW + EVENT_RETENTION_MS + 1000;
		hub.publish([event("a@x.com")], later);
		expect(hub.oldestId()).toBe(3);
		const ws = connect(hub, grant(null, "p:a", later + 3600_000));
		subscribe(hub, ws, { since: 0 }, later);
		expect(ws.messages().find((m) => m.type === "cursor_expired")).toMatchObject({ since: 0, oldest_id: 3 });
		expect(ws.events().map((e) => e.id)).toEqual([3]);
	});

	it("caps connections per principal (WebSocket and SSE together)", () => {
		const { hub } = hubOver();
		const g = grant(null);
		for (let i = 0; i < MAX_CONNECTIONS_PER_PRINCIPAL - 1; i++) connect(hub, g);
		const sse: SseClient = { grant: g, subscription: { mailboxes: null, events: null }, lastId: 0, write: () => true, close: () => {} };
		hub.openSse(sse, null, NOW);
		expect(hub.admit(g)).toMatchObject({ ok: false, status: 429 });
		// Someone else is unaffected.
		expect(hub.admit(grant(null, "p:bob"))).toEqual({ ok: true });
		hub.closeSse(sse);
		expect(hub.admit(g)).toEqual({ ok: true });
	});

	it("drops a slow consumer with a resume cursor (buffered bytes)", () => {
		const { hub } = hubOver();
		const ws = connect(hub, grant(null));
		subscribe(hub, ws, {});
		hub.publish([event("a@x.com")], NOW);
		ws.bufferedAmount = MAX_BUFFERED_BYTES + 1;
		hub.publish([event("a@x.com")], NOW);
		const overflow = ws.messages().find((m) => m.type === "overflow");
		expect(overflow).toMatchObject({ resume_from: 1 });
		expect(ws.closed?.code).toBe(CLOSE_SLOW_CONSUMER);
	});

	it("drops a consumer that outruns its send budget", () => {
		const { hub } = hubOver();
		const ws = connect(hub, grant(null));
		subscribe(hub, ws, {});
		hub.publish(Array.from({ length: SEND_BURST + 5 }, () => event("a@x.com")), NOW);
		expect(ws.events()).toHaveLength(SEND_BURST);
		expect(ws.closed?.code).toBe(CLOSE_SLOW_CONSUMER);
	});

	it("closes a connection whose authorization expired", () => {
		const { hub } = hubOver();
		const ws = connect(hub, grant(null, "p:a", NOW + 1000));
		subscribe(hub, ws, {});
		hub.publish([event("a@x.com")], NOW + 2000);
		expect(ws.closed?.code).toBe(CLOSE_REAUTHENTICATE);
		expect(ws.events()).toEqual([]);
	});

	it("answers ping and refuses junk", () => {
		const { hub } = hubOver();
		const ws = connect(hub, grant(null));
		hub.onMessage(ws, '{"type":"ping"}', NOW);
		hub.onMessage(ws, "not json", NOW);
		hub.onMessage(ws, '{"type":"subscribe","events":["bogus"]}', NOW);
		const types = ws.messages().map((m) => m.type);
		expect(types).toEqual(["hello", "pong", "error", "error"]);
	});

	it("serves SSE with ids, replay and the same filters", () => {
		const { hub } = hubOver();
		hub.publish([event("a@x.com"), event("b@x.com")], NOW);
		const chunks: string[] = [];
		const client: SseClient = {
			grant: grant(["a@x.com"]),
			subscription: { mailboxes: null, events: null },
			lastId: 0,
			write: (c) => (chunks.push(c), true),
			close: () => {},
		};
		hub.openSse(client, 0, NOW);
		hub.publish([event("a@x.com", "message.sent"), event("b@x.com")], NOW);
		const frames = chunks.filter((c) => c.startsWith("id: "));
		expect(frames.map((f) => f.split("\n")[0])).toEqual(["id: 1", "id: 3"]);
		expect(frames[1]).toContain("event: message.sent");
		expect(JSON.parse(frames[1].split("\n")[2].slice(6)).mailbox).toBe("a@x.com");
	});

	it("drops an SSE client whose stream is full", () => {
		const { hub } = hubOver();
		let room = 2;
		const close = vi.fn();
		const client: SseClient = { grant: grant(null), subscription: { mailboxes: null, events: null }, lastId: 0, write: () => room-- > 0, close };
		hub.openSse(client, null, NOW);
		hub.publish([event("a@x.com"), event("a@x.com")], NOW);
		expect(close).toHaveBeenCalled();
		expect(hub.connectionCount()).toBe(0);
	});
});

// ── Authorization ───────────────────────────────────────────────────

describe("readable mailboxes", () => {
	const ADMIN = "owner@example.com";
	const admin = () => decidePrincipal({ adminEmails: [ADMIN], identity: { kind: "user", id: ADMIN, subject: null } });
	const member = (grantEntries: { id: string; role: string }[]) =>
		decidePrincipal({
			adminEmails: [ADMIN],
			identity: { kind: "user", id: "m@example.com", subject: null },
			grant: {
				id: "m@example.com",
				kind: "user",
				role: "member",
				mailboxes: grantEntries.map((e) => e.id),
				access: grantEntries,
				updatedAt: "2026-01-01T00:00:00.000Z",
			} as never,
		});

	it("is everything for an unrestricted admin", () => {
		expect(readableMailboxes(admin(), ["a@x.com"])).toBeNull();
	});

	it("is the grant for a member", () => {
		expect(readableMailboxes(member([{ id: "a@x.com", role: "viewer" }]), ["a@x.com", "b@x.com"])).toEqual(["a@x.com"]);
	});

	it("is narrowed by a token's mailboxes, and empty without mail:read", () => {
		const tokened = applyTokenRestriction(admin(), { id: "t", scopes: ["mail:read"], mailboxes: ["b@x.com"] });
		expect(readableMailboxes(tokened, ["a@x.com", "b@x.com"])).toEqual(["b@x.com"]);
		const noRead = applyTokenRestriction(admin(), { id: "t", scopes: ["mail:send"], mailboxes: null });
		expect(readableMailboxes(noRead, ["a@x.com"])).toEqual([]);
	});
});

// ── Route ───────────────────────────────────────────────────────────

describe("GET /api/v1/events/*", () => {
	let forwarded: Request[];
	let objects: Map<string, string>;
	const ADMIN = "owner@example.com";

	beforeEach(() => {
		forwarded = [];
		objects = new Map([
			["mailboxes/support@example.com.json", "{}"],
			["mailboxes/sales@example.com.json", "{}"],
			["access/users/member@example.com.json", JSON.stringify({ id: "member@example.com", role: "member", mailboxes: [{ id: "support@example.com", role: "viewer" }] })],
		]);
	});

	function env(withEvents = true) {
		return {
			AUTH_MODE: "access",
			ADMIN_EMAILS: ADMIN,
			DOMAINS: "example.com",
			EMAIL_ADDRESSES: [],
			BUCKET: {
				head: async (k: string) => (objects.has(k) ? { key: k } : null),
				get: async (k: string) => {
					const raw = objects.get(k);
					return raw === undefined ? null : { json: async () => JSON.parse(raw) };
				},
				list: async (o: { prefix?: string }) => ({
					objects: [...objects.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((key) => ({ key })),
					truncated: false,
				}),
			},
			...(withEvents
				? {
						EVENTS: {
							idFromName: () => "global",
							get: () => ({
								fetch: async (req: Request) => {
									forwarded.push(req);
									return new Response("ok", { status: 200 });
								},
								publish: async () => ({ published: 0 }),
							}),
						},
					}
				: {}),
		} as never;
	}

	const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

	function call(path: string, opts: { identity?: string; token?: { scopes: string[] | null; mailboxes?: string[] | null }; headers?: Record<string, string>; withEvents?: boolean } = {}) {
		const outer = new Hono();
		outer.use("*", async (c, next) => {
			if (opts.identity) (c as any).set("accessIdentity", { kind: "user", id: opts.identity, subject: "s" });
			if (opts.token) {
				(c as any).set("authMethod", "token");
				(c as any).set("authToken", { id: "tok", userId: "u", name: "t", createdAt: 0, lastUsedAt: null, lastUsedIp: null, expiresAt: NOW + 60_000, scopes: opts.token.scopes, mailboxes: opts.token.mailboxes ?? null, parentId: null });
			}
			return next();
		});
		outer.route("/", app as never);
		return outer.fetch(new Request(`https://mailer.example.com${path}`, { headers: { "Sec-Fetch-Site": "same-origin", ...(opts.headers ?? {}) } }), env(opts.withEvents ?? true), ctx);
	}

	const upgrade = { upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };

	it("refuses an anonymous caller", async () => {
		expect((await call("/api/v1/events/stream", { headers: upgrade })).status).toBe(401);
		expect(forwarded).toEqual([]);
	});

	it("refuses a token without mail:read", async () => {
		const res = await call("/api/v1/events/sse", { identity: ADMIN, token: { scopes: ["mail:send"] } });
		expect(res.status).toBe(403);
		expect(((await res.json()) as any).scope).toBe("mail:read");
	});

	it("answers 426 without an upgrade and 503 without the binding", async () => {
		expect((await call("/api/v1/events/stream", { identity: ADMIN })).status).toBe(426);
		expect((await call("/api/v1/events/stream", { identity: ADMIN, headers: upgrade, withEvents: false })).status).toBe(503);
	});

	it("forwards a WebSocket with a grant the client cannot forge", async () => {
		const res = await call("/api/v1/events/stream?since=7", {
			identity: "member@example.com",
			headers: { ...upgrade, [EVENTS_GRANT_HEADER]: encodeURIComponent(JSON.stringify({ key: "x", readable: null, expiresAt: 9e15 })) },
		});
		expect(res.status).toBe(200);
		const req = forwarded[0];
		expect(new URL(req.url).pathname).toBe("/ws");
		expect(new URL(req.url).searchParams.get("since")).toBe("7");
		expect(req.headers.get("upgrade")).toBe("websocket");
		const g = decodeGrant(req.headers.get(EVENTS_GRANT_HEADER))!;
		expect(g.readable).toEqual(["support@example.com"]);
		expect(g.key).toBe("p:member@example.com");
	});

	it("caps a token connection's lifetime at the token's expiry", async () => {
		await call("/api/v1/events/sse", { identity: ADMIN, token: { scopes: ["mail:read"], mailboxes: ["sales@example.com"] } });
		const g = decodeGrant(forwarded[0].headers.get(EVENTS_GRANT_HEADER))!;
		expect(g.readable).toEqual(["sales@example.com"]);
		expect(g.expiresAt).toBe(NOW + 60_000);
		// The object gets something to re-check: a hash reference, never a secret.
		expect(g.credential).toBeDefined();
		expect(JSON.stringify(g)).not.toMatch(/ttk_/);
	});
});

// ── Fan-out ─────────────────────────────────────────────────────────

describe("MailboxDO ledger feeds the stream from its own cursor", () => {
	it("hands every event type to the stream without moving the webhook cursor", async () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT, subject TEXT, sender TEXT, recipient TEXT, cc TEXT,
				date TEXT, body TEXT, thread_id TEXT, snippet TEXT, sender_name TEXT);
			CREATE TABLE attachments (id TEXT, email_id TEXT);
			CREATE TABLE labels (id TEXT, name TEXT, sort_order INTEGER DEFAULT 0);
			CREATE TABLE email_labels (email_id TEXT, label_id TEXT);
			CREATE TABLE delivery_events (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT, recipient TEXT, event_type TEXT,
				source TEXT, provider_message_id TEXT, error_cause TEXT, error_detail TEXT, metadata TEXT, dedupe_key TEXT,
				occurred_at TEXT, created_at TEXT DEFAULT (datetime('now')));
		`);
		db.prepare(`INSERT INTO emails VALUES ('m1','sent','Hi','a@x.com','b@y.com',NULL,'d','x','t1','x','A')`).run();
		const kv = new Map<string, unknown>();
		const ctx = {
			storage: {
				sql: { exec: (q: string, ...b: unknown[]) => ({ toArray: () => db.prepare(q).all(...(b as never[])) as any[] }) },
				get: async (k: string) => kv.get(k),
				put: async (k: string, v: unknown) => void kv.set(k, v),
			},
		} as unknown as DurableObjectState;
		// Prime both cursors before the event, as a first flush would.
		await flushLedgerToWebhooks(ctx, "a@x.com", { enqueue: async () => ({ queued: 0 }), wantedTypes: async () => [] }, async () => []);
		await flushLedgerToWebhooks(ctx, "a@x.com", { enqueue: async () => ({ queued: 0 }), wantedTypes: async () => [] }, async () => [], STREAM_CURSOR_KEY);
		db.prepare(`INSERT INTO delivery_events (email_id, event_type, source, occurred_at) VALUES ('m1','sent','send','2026-10-26T00:00:00Z')`).run();

		const { hub } = hubOver();
		const ws = connect(hub, grant(null));
		subscribe(hub, ws, {});
		const all = async () => ["message.sent", "message.delivery_failed", "message.bounced", "message.opened", "message.clicked", "message.received"] as WebhookEventType[];
		const n = await flushLedgerToWebhooks(
			ctx,
			"a@x.com",
			{ wantedTypes: all, enqueue: async (events) => ({ queued: hub.publish(events, NOW) }) },
			all,
			STREAM_CURSOR_KEY,
		);
		expect(n).toBe(1);
		expect(ws.events()[0].event).toMatchObject({ type: "message.sent", mailbox: "a@x.com" });
		// The webhook cursor did not move: webhooks still see it.
		const webhook = vi.fn(async () => ({ queued: 1 }));
		expect(await flushLedgerToWebhooks(ctx, "a@x.com", { enqueue: webhook, wantedTypes: all }, all)).toBe(1);
	});
});
