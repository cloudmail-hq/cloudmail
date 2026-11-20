// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Event stream revocation: a connection's credential and mailbox grants are
 * re-checked while it is open, not only at the handshake.
 *
 * - The hub, over mocked hibernatable sockets, with a revalidator that is the
 *   real `createRevalidator` over a real AuthStore on node:sqlite and an R2
 *   fake holding grants. Revoking a token or session mid-stream closes it
 *   (4401) at the next epoch poll; with no epoch change it still closes
 *   within the 30 s re-check, including when only a delivery happens.
 * - Removing a mailbox from a grant mid-stream sends `subscription_revoked`
 *   and stops its events.
 * - An unreachable AuthDO closes every connection (4503).
 * - One validation per distinct credential, however many connections.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { sha256Hex } from "../workers/auth/crypto";
import {
	CLOSE_AUTH_UNAVAILABLE,
	CLOSE_CREDENTIAL_REVOKED,
	EPOCH_POLL_MS,
	EventsHub,
	REVALIDATE_INTERVAL_MS,
	type ConnectionGrant,
	type CredentialRef,
	type HubSocket,
	type Revalidator,
	type SseClient,
} from "../workers/lib/events-hub";
import { createRevalidator, type RevalidationStore } from "../workers/lib/events-auth";
import type { AuthUser } from "../workers/auth/types";
import type { EnqueueInput } from "../workers/lib/webhooks-store";

class FakeSocket implements HubSocket {
	sent: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	private attachment: unknown = null;
	send(data: string) {
		if (this.closed) throw new Error("closed");
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		this.closed = { code, reason };
	}
	serializeAttachment(v: unknown) {
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

function adapter(db: DatabaseSync): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(q: string, ...b: unknown[]) {
				const rows = db.prepare(q).all(...(b as never[])) as any[];
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

const NOW = Date.UTC(2026, 9, 27, 12);
const OWNER = "owner@example.com";
const MEMBER = "member@example.com";
const SUPPORT = "support@example.com";
const SALES = "sales@example.com";

let auth: AuthStore;
let objects: Map<string, string>;
let owner: AuthUser;
let member: AuthUser;

function bucket() {
	return {
		get: async (key: string) => {
			const raw = objects.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw) };
		},
		head: async (key: string) => (objects.has(key) ? { key } : null),
		list: async (o: { prefix?: string }) => ({
			objects: [...objects.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((key) => ({ key })),
			truncated: false,
		}),
	};
}

function env() {
	return { AUTH_MODE: "password", BUCKET: bucket(), ADMIN_EMAILS: "" } as never;
}

/** The real revalidator over the real store, with call counting and an outage switch. */
function realRevalidator() {
	const calls = { epoch: 0, sessions: 0, tokens: 0 };
	const down = { value: false };
	const store: RevalidationStore = {
		getAuthEpoch: async () => {
			calls.epoch += 1;
			if (down.value) throw new Error("AuthDO unreachable");
			return auth.getAuthEpoch();
		},
		validateSession: async (h, n) => {
			calls.sessions += 1;
			if (down.value) throw new Error("AuthDO unreachable");
			return auth.validateSession(h, n);
		},
		validateApiToken: async (id, h, n, ip) => {
			calls.tokens += 1;
			if (down.value) throw new Error("AuthDO unreachable");
			return auth.validateApiToken(id, h, n, ip);
		},
	};
	return { revalidator: createRevalidator(env(), { store }), calls, down };
}

function hubWith(revalidator: Revalidator) {
	const db = new DatabaseSync(":memory:");
	const sockets: { ws: FakeSocket; tags: string[] }[] = [];
	const hub = new EventsHub(
		{
			sql: {
				exec(q: string, ...b: unknown[]) {
					const rows = db.prepare(q).all(...(b as never[])) as any[];
					return { toArray: () => rows };
				},
			},
			acceptWebSocket: (ws, tags) => void sockets.push({ ws: ws as FakeSocket, tags }),
			getWebSockets: (tag) => sockets.filter((s) => !s.ws.closed && (!tag || s.tags.includes(tag))).map((s) => s.ws),
		},
		revalidator,
	);
	return hub;
}

let seq = 0;
function event(mailbox: string): EnqueueInput {
	seq += 1;
	const eventId = `evt_${seq}`;
	return { eventId, type: "message.received", mailbox, payload: JSON.stringify({ id: eventId, mailbox }), now: NOW };
}

async function mintToken(user: AuthUser, scopes: string[] | null, mailboxes: string[] | null = null) {
	const id = `tok${String(++seq).padStart(9, "0")}`;
	const secret = `secret-${seq}-xxxxxxxxxxxxxxxxxxxx`;
	await auth.createApiToken({ id, userId: user.id, name: "t", secretHash: await sha256Hex(secret), expiresAt: null, now: NOW, scopes, mailboxes });
	return { id, ref: { kind: "token", id, hash: await sha256Hex(secret) } as CredentialRef };
}

function connect(hub: EventsHub, readable: string[] | null, credential: CredentialRef, key = "p:x") {
	const grant: ConnectionGrant = { key, readable, expiresAt: NOW + 3600_000, credential };
	const ws = new FakeSocket();
	hub.acceptSocket(ws, grant, null);
	hub.onMessage(ws, JSON.stringify({ type: "subscribe" }), NOW);
	return ws;
}

beforeEach(async () => {
	seq = 0;
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	auth = new AuthStore(sql, tx);
	const created = await auth.createOwner({ email: OWNER, name: "O", passwordHash: "x", now: 1 });
	if (!created.ok) throw new Error("owner");
	owner = created.user;
	await auth.createInvite({ tokenHash: "inv", email: MEMBER, role: "member", mailboxes: [], createdBy: null, expiresAt: NOW + 1e9, now: 1 });
	const accepted = (await auth.acceptInvite({ tokenHash: "inv", name: "M", passwordHash: "x", now: 2 })) as { user: AuthUser };
	member = accepted.user;
	objects = new Map([
		[`mailboxes/${SUPPORT}.json`, "{}"],
		[`mailboxes/${SALES}.json`, "{}"],
		[
			`access/users/${MEMBER}.json`,
			JSON.stringify({
				id: MEMBER,
				kind: "user",
				role: "member",
				mailboxes: [SUPPORT, SALES],
				access: [
					{ id: SUPPORT, role: "viewer" },
					{ id: SALES, role: "viewer" },
				],
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
		],
	]);
});

describe("revoking a credential mid-stream", () => {
	it("closes a revoked token at the next epoch poll (within EPOCH_POLL_MS)", async () => {
		const { revalidator } = realRevalidator();
		const hub = hubWith(revalidator);
		const t = await mintToken(owner, ["mail:read"]);
		const ws = connect(hub, null, t.ref);
		await hub.revalidate(NOW); // first poll: records the epoch
		hub.publish([event(SUPPORT)], NOW);
		expect(ws.events()).toHaveLength(1);

		await auth.revokeApiToken(owner.id, t.id); // bumps the epoch
		await hub.revalidate(NOW + EPOCH_POLL_MS);
		expect(ws.closed?.code).toBe(CLOSE_CREDENTIAL_REVOKED);
		expect(ws.messages().some((m) => m.type === "credential_revoked")).toBe(true);
		hub.publish([event(SUPPORT)], NOW + EPOCH_POLL_MS);
		expect(ws.events()).toHaveLength(1);
	});

	it("closes a deleted session the same way", async () => {
		const { revalidator } = realRevalidator();
		const hub = hubWith(revalidator);
		const hash = await sha256Hex("cookie-token");
		await auth.createSession({ tokenHash: hash, userId: member.id, now: NOW, ip: null, userAgent: null } as never);
		const ws = connect(hub, [SUPPORT, SALES], { kind: "session", hash });
		await hub.revalidate(NOW);
		expect(ws.closed).toBeNull();
		await auth.deleteSession(hash);
		await hub.revalidate(NOW + EPOCH_POLL_MS);
		expect(ws.closed?.code).toBe(CLOSE_CREDENTIAL_REVOKED);
	});

	it("catches an expiry the epoch does not report, within the 30 s re-check, even with no poll", async () => {
		const { revalidator } = realRevalidator();
		const hub = hubWith(revalidator);
		const expiresAt = NOW + 10_000;
		const id = "tokexpiring01";
		await auth.createApiToken({ id, userId: owner.id, name: "t", secretHash: await sha256Hex("s".repeat(24)), expiresAt, now: NOW, scopes: ["mail:read"] });
		const ws = connect(hub, null, { kind: "token", id, hash: await sha256Hex("s".repeat(24)) });
		await hub.ensureFresh(NOW);
		expect(ws.closed).toBeNull();
		// No alarm ran; a delivery 30 s later re-checks first.
		await hub.ensureFresh(NOW + REVALIDATE_INTERVAL_MS);
		hub.publish([event(SUPPORT)], NOW + REVALIDATE_INTERVAL_MS);
		expect(ws.closed?.code).toBe(CLOSE_CREDENTIAL_REVOKED);
		expect(ws.events()).toHaveLength(0);
	});

	it("a delivery that joins an older in-flight poll still gets a full check", async () => {
		const { revalidator } = realRevalidator();
		const hub = hubWith(revalidator);
		const t = await mintToken(owner, ["mail:read"]);
		const ws = connect(hub, null, t.ref);
		await hub.revalidate(NOW);
		// Revoke without moving the epoch the poll will see: the poll started
		// at NOW + 5 s reads it as unchanged and inside the interval.
		const poll = hub.revalidate(NOW + EPOCH_POLL_MS);
		await auth.revokeApiToken(owner.id, t.id);
		// A publish arriving at NOW + 31 s joins that poll, then must check itself.
		await Promise.all([poll, hub.ensureFresh(NOW + REVALIDATE_INTERVAL_MS + 1000)]);
		expect(ws.closed?.code).toBe(CLOSE_CREDENTIAL_REVOKED);
	});

	it("checks each distinct credential once per poll, however many connections share it", async () => {
		const { revalidator, calls } = realRevalidator();
		const hub = hubWith(revalidator);
		const t = await mintToken(owner, ["mail:read"]);
		for (let i = 0; i < 4; i++) connect(hub, null, t.ref, `p:${i}`);
		await hub.revalidate(NOW);
		expect(calls.tokens).toBe(1);
		// Same epoch, inside the interval: only the epoch is read.
		await hub.revalidate(NOW + EPOCH_POLL_MS);
		expect(calls.tokens).toBe(1);
		expect(calls.epoch).toBe(2);
	});
});

describe("mailbox grants changing mid-stream", () => {
	it("sends subscription_revoked and stops events for a removed mailbox", async () => {
		const { revalidator } = realRevalidator();
		const hub = hubWith(revalidator);
		const hash = await sha256Hex("member-cookie");
		await auth.createSession({ tokenHash: hash, userId: member.id, now: NOW, ip: null, userAgent: null } as never);
		const ws = connect(hub, [SUPPORT, SALES], { kind: "session", hash });
		await hub.revalidate(NOW);
		hub.publish([event(SUPPORT), event(SALES)], NOW);
		expect(ws.events().map((e) => e.event.mailbox)).toEqual([SUPPORT, SALES]);

		// An admin removes sales@ from the member's grant (R2; no epoch change).
		const grant = JSON.parse(objects.get(`access/users/${MEMBER}.json`)!);
		objects.set(`access/users/${MEMBER}.json`, JSON.stringify({ ...grant, mailboxes: [SUPPORT], access: [{ id: SUPPORT, role: "viewer" }] }));
		await hub.ensureFresh(NOW + REVALIDATE_INTERVAL_MS);

		expect(ws.messages().filter((m) => m.type === "subscription_revoked")).toEqual([{ type: "subscription_revoked", mailbox: SALES }]);
		expect(ws.closed).toBeNull();
		hub.publish([event(SUPPORT), event(SALES)], NOW + REVALIDATE_INTERVAL_MS);
		expect(ws.events().map((e) => e.event.mailbox)).toEqual([SUPPORT, SALES, SUPPORT]);
	});

	it("drops a removed mailbox from an explicit subscription too, and tells SSE clients", async () => {
		const { revalidator } = realRevalidator();
		const hub = hubWith(revalidator);
		const hash = await sha256Hex("member-cookie-2");
		await auth.createSession({ tokenHash: hash, userId: member.id, now: NOW, ip: null, userAgent: null } as never);
		const chunks: string[] = [];
		const sse: SseClient = {
			grant: { key: "p:m", readable: [SUPPORT, SALES], expiresAt: NOW + 3600_000, credential: { kind: "session", hash } },
			subscription: { mailboxes: [SALES], events: null },
			lastId: 0,
			write: (c) => (chunks.push(c), true),
			close: () => {},
		};
		hub.openSse(sse, null, NOW);
		await hub.revalidate(NOW);
		const grant = JSON.parse(objects.get(`access/users/${MEMBER}.json`)!);
		objects.set(`access/users/${MEMBER}.json`, JSON.stringify({ ...grant, mailboxes: [SUPPORT], access: [{ id: SUPPORT, role: "viewer" }] }));
		await hub.revalidate(NOW + REVALIDATE_INTERVAL_MS);
		expect(chunks.some((c) => c.startsWith("event: subscription_revoked") && c.includes(SALES))).toBe(true);
		expect(sse.subscription.mailboxes).toEqual([]);
		hub.publish([event(SALES)], NOW + REVALIDATE_INTERVAL_MS);
		expect(chunks.some((c) => c.startsWith("id: "))).toBe(false);
	});

	it("narrows a token to its mailbox list on every re-check", async () => {
		const { revalidator } = realRevalidator();
		const hub = hubWith(revalidator);
		const t = await mintToken(owner, ["mail:read"], [SUPPORT]);
		const ws = connect(hub, [SUPPORT], t.ref);
		await hub.revalidate(NOW);
		hub.publish([event(SUPPORT), event(SALES)], NOW);
		expect(ws.events().map((e) => e.event.mailbox)).toEqual([SUPPORT]);
	});
});

describe("failing closed", () => {
	it("closes every connection when the AuthDO cannot be reached", async () => {
		const { revalidator, down } = realRevalidator();
		const hub = hubWith(revalidator);
		const t = await mintToken(owner, ["mail:read"]);
		const a = connect(hub, null, t.ref, "p:a");
		const b = connect(hub, null, t.ref, "p:b");
		await hub.revalidate(NOW);
		down.value = true;
		await hub.revalidate(NOW + EPOCH_POLL_MS);
		for (const ws of [a, b]) {
			expect(ws.closed?.code).toBe(CLOSE_AUTH_UNAVAILABLE);
			expect(ws.messages().some((m) => m.type === "auth_unavailable")).toBe(true);
		}
	});

	it("fails closed when validation (not the epoch) throws", async () => {
		const hub = hubWith({
			epoch: async () => 1,
			validate: vi.fn(async () => {
				throw new Error("R2 down");
			}),
		});
		const ws = connect(hub, null, { kind: "identity", identity: null, developmentBypass: true });
		await hub.revalidate(NOW);
		expect(ws.closed?.code).toBe(CLOSE_AUTH_UNAVAILABLE);
	});

	it("closes a connection whose grant carries no credential to re-check", async () => {
		const hub = hubWith({ epoch: async () => 1, validate: async () => new Map() });
		const ws = new FakeSocket();
		hub.acceptSocket(ws, { key: "p:x", readable: null, expiresAt: NOW + 3600_000 }, null);
		await hub.revalidate(NOW);
		expect(ws.closed).not.toBeNull();
	});
});
