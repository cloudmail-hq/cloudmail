// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The deployment-wide realtime event stream object (`idFromName("global")`).
 *
 * One instance per deployment, like WebhookDO: it is fed by the same fan-out
 * (MailboxDO's ledger flush and the inbound handler), and a single object
 * keeps event ids monotonic across every mailbox, which is what makes one
 * `?since=` cursor enough to resume.
 *
 * WebSockets use the hibernation API: idle connections cost nothing, and each
 * socket's grant and subscription live in its attachment. SSE streams cannot
 * hibernate, so they are held in memory and kept alive by an alarm heartbeat.
 *
 * All logic is in `./events-hub.ts`; this file is the Cloudflare wiring.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type { EnqueueInput } from "./webhooks-store";
import {
	EPOCH_POLL_MS,
	EventsHub,
	parseCursor,
	type ConnectionGrant,
	type HubSocket,
	type SseClient,
} from "./events-hub";
import { EVENTS_GRANT_HEADER, decodeGrant } from "./events";
import { createRevalidator } from "./events-auth";

/** Bytes an SSE stream may queue before the client counts as too slow. */
const SSE_HIGH_WATER = 256 * 1024;

export class EventsDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	private hub!: EventsHub;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.hub = new EventsHub(
				{
					sql: ctx.storage.sql,
					acceptWebSocket: (ws, tags) => ctx.acceptWebSocket(ws as unknown as WebSocket, tags),
					getWebSockets: (tag) => ctx.getWebSockets(tag) as unknown as HubSocket[],
				},
				// Re-checks credentials and grants while connections are open; see
				// ./events-auth.ts and the module comment in ./events-hub.ts.
				createRevalidator(env),
			);
		});
	}

	/** Store and fan out. Called by MailboxDO and the inbound handler. */
	async publish(events: EnqueueInput[]): Promise<{ published: number }> {
		const now = Date.now();
		// Never deliver on an authorization older than the re-check interval.
		await this.hub.ensureFresh(now);
		return { published: this.hub.publish(events, now) };
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const grant = decodeGrant(request.headers.get(EVENTS_GRANT_HEADER));
		if (!grant) return Response.json({ error: "missing grant" }, { status: 400 });

		const admitted = this.hub.admit(grant);
		if (!admitted.ok) return Response.json({ error: admitted.error }, { status: admitted.status });
		const since = parseCursor(url.searchParams.get("since") ?? request.headers.get("last-event-id"));

		if (url.pathname === "/ws") {
			if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
				return Response.json({ error: "Expected a WebSocket upgrade" }, { status: 426 });
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.hub.acceptSocket(server as unknown as HubSocket, grant, since);
			// The poll that re-validates this connection (see alarm()).
			this.ctx.waitUntil(this.armHeartbeat());
			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === "/sse") return this.openSse(grant, url, since);
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	private openSse(grant: ConnectionGrant, url: URL, since: number | null): Response {
		const mailboxes = url.searchParams.getAll("mailbox").map((m) => m.toLowerCase());
		const events = url.searchParams.getAll("event");
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(undefined, { highWaterMark: SSE_HIGH_WATER });
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		let closed = false;
		const client: SseClient = {
			grant,
			subscription: {
				// Only readable mailboxes; an empty filter means all of them.
				mailboxes: mailboxes.length > 0 ? mailboxes.filter((m) => grant.readable === null || grant.readable.includes(m)) : null,
				events: events.length > 0 ? (events as SseClient["subscription"]["events"]) : null,
			},
			lastId: since ?? 0,
			write: (chunk) => {
				if (closed) return false;
				if ((writer.desiredSize ?? 1) <= 0) return false;
				writer.write(encoder.encode(chunk)).catch(() => {
					closed = true;
					this.hub.closeSse(client);
				});
				return true;
			},
			close: () => {
				if (closed) return;
				closed = true;
				writer.close().catch(() => {});
			},
		};
		writer.closed.then(
			() => this.hub.closeSse(client),
			() => this.hub.closeSse(client),
		);
		this.hub.openSse(client, since, Date.now());
		this.ctx.waitUntil(this.armHeartbeat());
		return new Response(readable, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				"X-Accel-Buffering": "no",
			},
		});
	}

	private async armHeartbeat(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + EPOCH_POLL_MS);
	}

	/**
	 * Every {@link EPOCH_POLL_MS} while anything is connected: poll the auth
	 * epoch (re-validating on a change or every 30 s), then expiry, keepalive
	 * and pruning. One epoch RPC per tick for the whole deployment.
	 */
	async alarm(): Promise<void> {
		const now = Date.now();
		await this.hub.revalidate(now);
		this.hub.tick(now);
		this.hub.prune(now);
		if (this.hub.hasConnections()) await this.ctx.storage.setAlarm(now + EPOCH_POLL_MS);
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const now = Date.now();
		await this.hub.ensureFresh(now);
		this.hub.onMessage(ws as unknown as HubSocket, message, now);
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		try {
			ws.close(code === 1005 ? 1000 : code, "closed");
		} catch {
			// already closed
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		try {
			ws.close(1011, "error");
		} catch {
			// already closed
		}
	}
}
