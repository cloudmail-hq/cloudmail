// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The realtime event stream's core: a 24-hour event log with monotonic ids,
 * subscription filtering, authorization filtering, caps and backpressure.
 *
 * No `cloudflare:workers` import, so it runs under Node in the tests. The
 * Durable Object in `./events-do.ts` wires it to hibernatable WebSockets,
 * `ctx.storage.sql` and SSE streams.
 *
 * Trust model: the Worker route (`workers/routes/events.ts`) authenticates the
 * caller, checks `mail:read`, and computes the list of mailboxes the principal
 * may read. That list (the "grant") travels to the object in a header the
 * Worker sets on a request it builds itself, so a client cannot supply it.
 * Every event is checked against the grant before it is sent, whatever the
 * client subscribed to.
 *
 * Revocation: the grant also carries a reference to the credential (a session
 * hash, or a token id and secret hash, never a secret). While connections are
 * open the object polls the AuthDO auth epoch every {@link EPOCH_POLL_MS} (see
 * `workers/auth/session-cache.ts`) and re-validates every distinct credential
 * whenever it moves, and at least every {@link REVALIDATE_INTERVAL_MS}
 * regardless, re-reading the readable mailboxes from R2 at the same time.
 * Delivery and client messages also re-check first when the interval has
 * passed, so a stalled heartbeat cannot stretch the bound.
 *
 * - A revoked credential: `credential_revoked`, closed with
 *   {@link CLOSE_CREDENTIAL_REVOKED}.
 * - A mailbox that left the grant: `subscription_revoked`, no more events.
 * - AuthDO or R2 unreachable: every connection closed with
 *   {@link CLOSE_AUTH_UNAVAILABLE} (fail closed). Clients resume with `since`.
 */

import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "../../shared/webhooks";
import type { EnqueueInput } from "./webhooks-store";

// ── Limits ──────────────────────────────────────────────────────────

/** How long events are kept for `?since=` replay. */
export const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Open connections (WebSocket + SSE) one principal may hold. */
export const MAX_CONNECTIONS_PER_PRINCIPAL = 5;
/** Open connections across the deployment. */
export const MAX_CONNECTIONS_TOTAL = 500;
/** Events replayed in one go; past this the client is told to page with `since`. */
export const MAX_REPLAY = 1000;
/** Mailboxes one subscription may name. */
export const MAX_SUBSCRIBE_MAILBOXES = 100;
/** Largest client message accepted. */
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
/**
 * Longest a connection lives before it must re-authenticate. Grants and
 * tokens can change; a connection holds a snapshot of them, so it is bounded.
 */
export const MAX_CONNECTION_LIFETIME_MS = 60 * 60 * 1000;
/** Queued bytes on a socket past which the client is treated as too slow. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Token bucket per connection: burst size and refill per second. */
export const SEND_BURST = 500;
export const SEND_REFILL_PER_SECOND = 100;

/**
 * Longest a connection goes without its credential and mailbox grants being
 * re-checked. An auth epoch change re-checks sooner (within one poll).
 */
export const REVALIDATE_INTERVAL_MS = 30_000;
/** How often the object polls the auth epoch while connections are open. */
export const EPOCH_POLL_MS = 5_000;

/** Close codes. 1008 policy, 1013 try again later, 4001 re-authenticate. */
export const CLOSE_SLOW_CONSUMER = 1013;
export const CLOSE_REAUTHENTICATE = 4001;
export const CLOSE_POLICY = 1008;
/** The session or token was revoked or expired, or its user disabled. */
export const CLOSE_CREDENTIAL_REVOKED = 4401;
/** Authorization could not be re-checked (AuthDO or R2 unreachable). Reconnect. */
export const CLOSE_AUTH_UNAVAILABLE = 4503;

// ── Types ───────────────────────────────────────────────────────────

/**
 * How to re-check the caller. Hashes only: the object never holds a secret.
 * `identity` is an Access or development caller, which has no AuthDO
 * credential; its grants are still re-read from R2 on the same cadence.
 */
export type CredentialRef =
	| { kind: "session"; hash: string }
	| { kind: "token"; id: string; hash: string }
	| {
			kind: "identity";
			identity: { kind: "user" | "service"; id: string; subject: string | null } | null;
			developmentBypass: boolean;
	  };

/** What the Worker established about the caller. */
export interface ConnectionGrant {
	/** Connection-cap key: one per principal. */
	key: string;
	/** Mailboxes the principal may read, lowercased; null = every mailbox. */
	readable: string[] | null;
	/** When the connection must be dropped for re-authentication (unix ms). */
	expiresAt: number;
	/** What to re-validate. A grant without one cannot be re-checked and is closed. */
	credential?: CredentialRef;
}

/** One credential's re-check. */
export type RevalidationResult =
	| { ok: true; readable: string[] | null; expiresAt?: number | null }
	| { ok: false; reason: "revoked" };

/**
 * The checks the object cannot do alone: the AuthDO auth epoch, credential
 * validation and the R2 grant read. Either method throwing means "could not
 * confirm", which closes every connection.
 */
export interface Revalidator {
	epoch(): Promise<number>;
	/** Results keyed by {@link credentialKey}; one call per batch. */
	validate(credentials: CredentialRef[], now: number): Promise<Map<string, RevalidationResult>>;
}

/** A stable key for one credential, so N connections cost one check. */
export function credentialKey(ref: CredentialRef | undefined): string {
	if (!ref) return "none";
	if (ref.kind === "session") return `s:${ref.hash}`;
	if (ref.kind === "token") return `t:${ref.id}:${ref.hash}`;
	return `i:${ref.developmentBypass ? "dev" : ""}:${ref.identity?.kind ?? ""}:${(ref.identity?.id ?? "").toLowerCase()}`;
}

export interface Subscription {
	/** null = every readable mailbox; [] = none. */
	mailboxes: string[] | null;
	/** null = every event type. */
	events: WebhookEventType[] | null;
}

/** Stored on each WebSocket, so it survives hibernation. */
export interface SocketAttachment {
	grant: ConnectionGrant;
	subscription: Subscription | null;
	/** Cursor from `?since=`, used by the first subscribe. */
	since: number | null;
	/** Highest event id sent on this socket. */
	lastId: number;
}

export interface HubSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
	/** Not every runtime exposes it; used when it does. */
	readonly bufferedAmount?: number;
}

export interface EventsSql {
	exec(query: string, ...bindings: unknown[]): { toArray(): any[] };
}

export interface HubHost {
	sql: EventsSql;
	acceptWebSocket(ws: HubSocket, tags: string[]): void;
	getWebSockets(tag?: string): HubSocket[];
}

/** One SSE client, held in memory (SSE streams do not hibernate). */
export interface SseClient {
	grant: ConnectionGrant;
	subscription: Subscription;
	lastId: number;
	write(chunk: string): boolean;
	close(): void;
}

export interface StoredEvent {
	id: number;
	eventId: string;
	type: WebhookEventType;
	mailbox: string;
	payload: string;
	createdAt: number;
}

// ── Pure helpers ────────────────────────────────────────────────────

export function canSee(grant: Pick<ConnectionGrant, "readable">, mailbox: string): boolean {
	return grant.readable === null || grant.readable.includes(mailbox.toLowerCase());
}

/** Whether an event goes to a connection with this grant and subscription. */
export function matches(
	grant: Pick<ConnectionGrant, "readable">,
	subscription: Subscription | null,
	event: Pick<StoredEvent, "mailbox" | "type">,
): boolean {
	if (!subscription) return false;
	const mailbox = event.mailbox.toLowerCase();
	if (!canSee(grant, mailbox)) return false;
	if (subscription.mailboxes !== null && !subscription.mailboxes.includes(mailbox)) return false;
	if (subscription.events !== null && !subscription.events.includes(event.type)) return false;
	return true;
}

export type ParsedSubscribe =
	| { ok: true; subscription: Subscription; denied: string[]; since: number | null }
	| { ok: false; error: string };

/**
 * Validate a subscribe request against the grant. Mailboxes the grant does not
 * cover are dropped and reported in `denied`, never silently widened: asking
 * only for unreadable mailboxes subscribes to nothing.
 */
export function parseSubscribe(grant: ConnectionGrant, input: Record<string, unknown>): ParsedSubscribe {
	let mailboxes: string[] | null = null;
	const denied: string[] = [];
	if (input.mailboxes !== undefined && input.mailboxes !== null) {
		if (!Array.isArray(input.mailboxes) || input.mailboxes.some((m) => typeof m !== "string")) {
			return { ok: false, error: "mailboxes must be an array of addresses" };
		}
		if (input.mailboxes.length > MAX_SUBSCRIBE_MAILBOXES) {
			return { ok: false, error: `at most ${MAX_SUBSCRIBE_MAILBOXES} mailboxes per subscription` };
		}
		const wanted = [...new Set((input.mailboxes as string[]).map((m) => m.trim().toLowerCase()).filter(Boolean))];
		if (wanted.length > 0) {
			mailboxes = [];
			for (const m of wanted) (canSee(grant, m) ? mailboxes : denied).push(m);
		}
	}
	let events: WebhookEventType[] | null = null;
	if (input.events !== undefined && input.events !== null) {
		if (!Array.isArray(input.events)) return { ok: false, error: "events must be an array" };
		const unknown = input.events.filter((e) => !(WEBHOOK_EVENT_TYPES as readonly unknown[]).includes(e));
		if (unknown.length > 0) {
			return { ok: false, error: `unknown event type(s): ${unknown.join(", ")}. Known: ${WEBHOOK_EVENT_TYPES.join(", ")}` };
		}
		if (input.events.length > 0) events = [...new Set(input.events as WebhookEventType[])];
	}
	let since: number | null = null;
	if (input.since !== undefined && input.since !== null) {
		const n = Number(input.since);
		if (!Number.isSafeInteger(n) || n < 0) return { ok: false, error: "since must be a non-negative event id" };
		since = n;
	}
	return { ok: true, subscription: { mailboxes, events }, denied, since };
}

/** `?since=` / `Last-Event-ID`: a non-negative integer, or null. */
export function parseCursor(value: string | null | undefined): number | null {
	if (value === null || value === undefined || value.trim() === "") return null;
	const n = Number(value.trim());
	return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** The frame sent for one event. The payload is the webhook body, verbatim. */
export function eventFrame(event: Pick<StoredEvent, "id" | "payload">): string {
	return `{"type":"event","id":${event.id},"event":${event.payload}}`;
}

/** The SSE form of one event. */
export function sseFrame(event: Pick<StoredEvent, "id" | "type" | "payload">): string {
	return `id: ${event.id}\nevent: ${event.type}\ndata: ${event.payload}\n\n`;
}

// ── Hub ─────────────────────────────────────────────────────────────

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS stream_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		event_id TEXT NOT NULL UNIQUE,
		type TEXT NOT NULL,
		mailbox TEXT NOT NULL,
		payload TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_stream_events_created ON stream_events(created_at)`,
];

function rowToEvent(row: any): StoredEvent {
	return {
		id: Number(row.id),
		eventId: String(row.event_id),
		type: String(row.type) as WebhookEventType,
		mailbox: String(row.mailbox),
		payload: String(row.payload),
		createdAt: Number(row.created_at),
	};
}

export type AdmitResult = { ok: true } | { ok: false; status: 429 | 503; error: string };

export class EventsHub {
	/** Per-socket send budgets. In memory: a woken object starts every socket full. */
	private budgets = new WeakMap<HubSocket, { tokens: number; at: number }>();
	readonly sse = new Set<SseClient>();
	/**
	 * The epoch and time of the last full re-check. In memory: a woken object
	 * starts with none, so its first look re-checks everything.
	 */
	private lastEpoch: number | null = null;
	private lastCheckedAt = 0;
	private revalidating: Promise<void> | null = null;

	constructor(
		private readonly host: HubHost,
		private readonly revalidator: Revalidator | null = null,
	) {
		for (const stmt of SCHEMA) host.sql.exec(stmt);
	}

	// ── Revalidation ───────────────────────────────────────────────

	hasConnections(): boolean {
		return this.sse.size > 0 || this.host.getWebSockets().length > 0;
	}

	/**
	 * Re-check when the interval has passed. Called before delivering and before
	 * handling a client message. Cheap when nothing is due.
	 */
	async ensureFresh(now: number): Promise<void> {
		if (!this.revalidator || !this.hasConnections()) return;
		const stale = () => this.lastEpoch === null || now - this.lastCheckedAt >= REVALIDATE_INTERVAL_MS;
		if (!stale()) return;
		await this.revalidate(now);
		// A run already in flight was started with an earlier `now` and may have
		// judged itself not due. If this caller still needs a check, force one.
		if (stale() && this.hasConnections()) await this.revalidate(now, { force: true });
	}

	/**
	 * The poll: read the epoch, and re-validate every connection when it moved
	 * or the interval has passed. Concurrent calls share one run.
	 */
	async revalidate(now: number, options: { force?: boolean } = {}): Promise<void> {
		if (!this.revalidator || !this.hasConnections()) return;
		if (this.revalidating) return this.revalidating;
		this.revalidating = this.runRevalidation(now, options.force === true).finally(() => {
			this.revalidating = null;
		});
		return this.revalidating;
	}

	private async runRevalidation(now: number, force: boolean): Promise<void> {
		const revalidator = this.revalidator!;
		let epoch: number;
		try {
			epoch = await revalidator.epoch();
		} catch (e) {
			this.failClosed(`auth epoch unavailable: ${(e as Error).message}`);
			return;
		}
		const due = force || this.lastEpoch === null || epoch !== this.lastEpoch || now - this.lastCheckedAt >= REVALIDATE_INTERVAL_MS;
		if (!due) return;

		// One check per distinct credential, however many connections share it.
		const sockets = this.host.getWebSockets().map((ws) => ({ ws, a: this.attachmentOf(ws) }));
		const sse = [...this.sse];
		const byKey = new Map<string, CredentialRef>();
		for (const { a } of sockets) if (a?.grant.credential) byKey.set(credentialKey(a.grant.credential), a.grant.credential);
		for (const c of sse) if (c.grant.credential) byKey.set(credentialKey(c.grant.credential), c.grant.credential);

		let results: Map<string, RevalidationResult>;
		try {
			results = byKey.size > 0 ? await revalidator.validate([...byKey.values()], now) : new Map();
		} catch (e) {
			this.failClosed(`credential check failed: ${(e as Error).message}`);
			return;
		}

		for (const { ws, a } of sockets) {
			if (!a) continue;
			const verdict = a.grant.credential ? results.get(credentialKey(a.grant.credential)) : undefined;
			if (!verdict) {
				ws.close(CLOSE_REAUTHENTICATE, "authorization cannot be re-checked; reconnect");
				continue;
			}
			if (!verdict.ok) {
				this.send(ws, { type: "credential_revoked", error: "This session or API token is no longer valid." });
				ws.close(CLOSE_CREDENTIAL_REVOKED, "credential_revoked");
				continue;
			}
			for (const mailbox of this.applyGrant(a.grant, a.subscription, verdict)) {
				this.send(ws, { type: "subscription_revoked", mailbox });
			}
			ws.serializeAttachment(a);
		}
		for (const client of sse) {
			const verdict = client.grant.credential ? results.get(credentialKey(client.grant.credential)) : undefined;
			if (!verdict || !verdict.ok) {
				client.write(`event: credential_revoked\ndata: {}\n\n`);
				this.dropSse(client);
				continue;
			}
			for (const mailbox of this.applyGrant(client.grant, client.subscription, verdict)) {
				client.write(`event: subscription_revoked\ndata: ${JSON.stringify({ mailbox })}\n\n`);
			}
		}
		this.lastEpoch = epoch;
		this.lastCheckedAt = now;
	}

	/**
	 * Move a grant to the fresh readable set. Returns mailboxes the connection
	 * was getting (or had asked for) and may no longer see, so the client can be
	 * told. A subscription naming a removed mailbox drops it.
	 */
	private applyGrant(
		grant: ConnectionGrant,
		subscription: Subscription | null,
		verdict: { readable: string[] | null; expiresAt?: number | null },
	): string[] {
		const before = grant.readable;
		const after = verdict.readable === null ? null : verdict.readable.map((m) => m.toLowerCase());
		grant.readable = after;
		if (typeof verdict.expiresAt === "number") grant.expiresAt = Math.min(grant.expiresAt, verdict.expiresAt);
		if (after === null) return [];
		const removed = new Set<string>();
		if (before !== null) for (const m of before) if (!after.includes(m)) removed.add(m);
		if (subscription?.mailboxes) {
			for (const m of subscription.mailboxes) if (!after.includes(m)) removed.add(m);
			subscription.mailboxes = subscription.mailboxes.filter((m) => after.includes(m));
		}
		return [...removed];
	}

	/** Could not confirm anyone's authorization: close everything. */
	private failClosed(reason: string): void {
		console.error(`event stream: ${reason}; closing connections`);
		for (const ws of this.host.getWebSockets()) {
			this.send(ws, { type: "auth_unavailable", error: "Authorization could not be re-checked. Reconnect with since." });
			ws.close(CLOSE_AUTH_UNAVAILABLE, "auth_unavailable");
		}
		for (const client of [...this.sse]) {
			client.write(`event: auth_unavailable\ndata: {}\n\n`);
			this.dropSse(client);
		}
		this.lastEpoch = null;
		this.lastCheckedAt = 0;
	}

	// ── Log ────────────────────────────────────────────────────────

	prune(now: number): void {
		this.host.sql.exec(`DELETE FROM stream_events WHERE created_at < ?`, now - EVENT_RETENTION_MS);
	}

	/** Oldest id still retained, or null when the log is empty. */
	oldestId(): number | null {
		const row = this.host.sql.exec(`SELECT MIN(id) AS id FROM stream_events`).toArray()[0];
		return row && row.id !== null && row.id !== undefined ? Number(row.id) : null;
	}

	/** Highest id ever issued (ids are never reused, even after pruning). */
	latestId(): number {
		try {
			const row = this.host.sql.exec(`SELECT seq FROM sqlite_sequence WHERE name = 'stream_events'`).toArray()[0];
			if (row) return Number(row.seq);
		} catch {
			// A runtime that hides sqlite_sequence: fall back to the retained maximum.
		}
		const row = this.host.sql.exec(`SELECT MAX(id) AS id FROM stream_events`).toArray()[0];
		return row && row.id !== null && row.id !== undefined ? Number(row.id) : 0;
	}

	/** Events after `since`, oldest first, at most `limit`. */
	eventsAfter(since: number, limit: number): StoredEvent[] {
		return this.host.sql
			.exec(
				`SELECT id, event_id, type, mailbox, payload, created_at FROM stream_events
				  WHERE id > ? ORDER BY id ASC LIMIT ?`,
				since,
				limit,
			)
			.toArray()
			.map(rowToEvent);
	}

	/**
	 * Store events and fan them out. An event id already stored is skipped, so
	 * a ledger replay never repeats one. Returns how many were new.
	 */
	publish(events: EnqueueInput[], now: number): number {
		this.prune(now);
		const fresh: StoredEvent[] = [];
		for (const e of events) {
			const rows = this.host.sql
				.exec(
					`INSERT INTO stream_events (event_id, type, mailbox, payload, created_at)
					 VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING RETURNING id`,
					e.eventId,
					e.type,
					e.mailbox.toLowerCase(),
					e.payload,
					now,
				)
				.toArray();
			if (rows.length === 0) continue;
			fresh.push({ id: Number(rows[0].id), eventId: e.eventId, type: e.type, mailbox: e.mailbox.toLowerCase(), payload: e.payload, createdAt: now });
		}
		if (fresh.length === 0) return 0;
		for (const ws of this.host.getWebSockets()) this.deliverToSocket(ws, fresh, now);
		for (const client of [...this.sse]) this.deliverToSse(client, fresh, now);
		return fresh.length;
	}

	// ── Connections ────────────────────────────────────────────────

	connectionCount(key?: string): number {
		const sockets = this.host.getWebSockets(key).length;
		const sse = [...this.sse].filter((c) => key === undefined || c.grant.key === key).length;
		return sockets + sse;
	}

	/** Whether one more connection for this principal fits under the caps. */
	admit(grant: ConnectionGrant): AdmitResult {
		if (this.connectionCount() >= MAX_CONNECTIONS_TOTAL) {
			return { ok: false, status: 503, error: "The event stream is at capacity. Try again shortly." };
		}
		if (this.connectionCount(grant.key) >= MAX_CONNECTIONS_PER_PRINCIPAL) {
			return {
				ok: false,
				status: 429,
				error: `At most ${MAX_CONNECTIONS_PER_PRINCIPAL} open event streams per user. Close one first.`,
			};
		}
		return { ok: true };
	}

	/** Accept a WebSocket that `admit` cleared. */
	acceptSocket(ws: HubSocket, grant: ConnectionGrant, since: number | null): void {
		const attachment: SocketAttachment = { grant, subscription: null, since, lastId: since ?? 0 };
		this.host.acceptWebSocket(ws, [grant.key]);
		ws.serializeAttachment(attachment);
		this.send(ws, {
			type: "hello",
			latest_id: this.latestId(),
			oldest_id: this.oldestId(),
			readable: grant.readable ?? "all",
			expires_at: grant.expiresAt,
			limits: { max_subscribe_mailboxes: MAX_SUBSCRIBE_MAILBOXES, max_replay: MAX_REPLAY, retention_ms: EVENT_RETENTION_MS },
		});
	}

	private attachmentOf(ws: HubSocket): SocketAttachment | null {
		const a = ws.deserializeAttachment() as SocketAttachment | null;
		return a && typeof a === "object" && a.grant ? a : null;
	}

	private send(ws: HubSocket, message: unknown): void {
		try {
			ws.send(typeof message === "string" ? message : JSON.stringify(message));
		} catch {
			// A socket that cannot take a write is closing; its close handler cleans up.
		}
	}

	private expired(grant: ConnectionGrant, now: number): boolean {
		return grant.expiresAt <= now;
	}

	/** Handle one client message. */
	onMessage(ws: HubSocket, raw: string | ArrayBuffer, now: number): void {
		const attachment = this.attachmentOf(ws);
		if (!attachment) {
			ws.close(CLOSE_POLICY, "unknown connection");
			return;
		}
		if (this.expired(attachment.grant, now)) {
			ws.close(CLOSE_REAUTHENTICATE, "authorization expired; reconnect");
			return;
		}
		const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
		if (text.length > MAX_CLIENT_MESSAGE_BYTES) {
			this.send(ws, { type: "error", code: "message_too_large", error: "message too large" });
			return;
		}
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(text) as Record<string, unknown>;
		} catch {
			this.send(ws, { type: "error", code: "invalid_json", error: "messages must be JSON" });
			return;
		}
		if (!message || typeof message !== "object") {
			this.send(ws, { type: "error", code: "invalid_message", error: "messages must be JSON objects" });
			return;
		}
		switch (message.type) {
			case "ping":
				this.send(ws, { type: "pong", latest_id: this.latestId() });
				return;
			case "unsubscribe":
				attachment.subscription = null;
				ws.serializeAttachment(attachment);
				this.send(ws, { type: "unsubscribed" });
				return;
			case "subscribe": {
				const parsed = parseSubscribe(attachment.grant, message);
				if (!parsed.ok) {
					this.send(ws, { type: "error", code: "invalid_subscribe", error: parsed.error });
					return;
				}
				attachment.subscription = parsed.subscription;
				const since = parsed.since ?? attachment.since;
				attachment.since = null;
				ws.serializeAttachment(attachment);
				this.send(ws, {
					type: "subscribed",
					mailboxes: parsed.subscription.mailboxes ?? "all",
					events: parsed.subscription.events ?? "all",
					denied: parsed.denied,
				});
				if (since !== null) this.replayToSocket(ws, attachment, since, now);
				return;
			}
			default:
				this.send(ws, { type: "error", code: "unknown_type", error: "expected subscribe, unsubscribe or ping" });
		}
	}

	/** Send stored events after `since` that this socket may see. */
	private replayToSocket(ws: HubSocket, attachment: SocketAttachment, since: number, now: number): void {
		this.prune(now);
		const oldest = this.oldestId();
		if (oldest !== null && since < oldest - 1) {
			this.send(ws, { type: "cursor_expired", since, oldest_id: oldest, error: "Some events after this cursor are older than 24 hours and are gone." });
		}
		let cursor = since;
		let sent = 0;
		for (;;) {
			const page = this.eventsAfter(cursor, 200);
			if (page.length === 0) break;
			for (const event of page) {
				cursor = event.id;
				if (!matches(attachment.grant, attachment.subscription, event)) continue;
				if (sent >= MAX_REPLAY) {
					this.send(ws, { type: "replay_truncated", resume_from: attachment.lastId });
					ws.serializeAttachment(attachment);
					return;
				}
				this.send(ws, eventFrame(event));
				attachment.lastId = event.id;
				sent += 1;
			}
			if (page.length < 200) break;
		}
		this.send(ws, { type: "replayed", count: sent, latest_id: this.latestId() });
		ws.serializeAttachment(attachment);
	}

	/** Spend one send from the socket's bucket; false when it is empty. */
	private takeBudget(ws: HubSocket, now: number): boolean {
		const b = this.budgets.get(ws) ?? { tokens: SEND_BURST, at: now };
		b.tokens = Math.min(SEND_BURST, b.tokens + ((now - b.at) / 1000) * SEND_REFILL_PER_SECOND);
		b.at = now;
		this.budgets.set(ws, b);
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}

	private deliverToSocket(ws: HubSocket, events: StoredEvent[], now: number): void {
		const attachment = this.attachmentOf(ws);
		if (!attachment || !attachment.subscription) return;
		if (this.expired(attachment.grant, now)) {
			ws.close(CLOSE_REAUTHENTICATE, "authorization expired; reconnect");
			return;
		}
		let lastId = attachment.lastId;
		for (const event of events) {
			if (!matches(attachment.grant, attachment.subscription, event)) continue;
			// Backpressure: a client that is not keeping up is told where to resume
			// and dropped, rather than buffered without bound.
			const buffered = typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : 0;
			if (buffered > MAX_BUFFERED_BYTES || !this.takeBudget(ws, now)) {
				this.send(ws, { type: "overflow", resume_from: lastId, error: "Too slow to keep up; reconnect with ?since=resume_from." });
				ws.close(CLOSE_SLOW_CONSUMER, "slow consumer; reconnect with since");
				break;
			}
			this.send(ws, eventFrame(event));
			lastId = event.id;
		}
		if (lastId !== attachment.lastId) {
			attachment.lastId = lastId;
			ws.serializeAttachment(attachment);
		}
	}

	// ── SSE ────────────────────────────────────────────────────────

	/**
	 * Register an SSE client and replay to it. `admit` must have cleared it.
	 * Returns false when the client was dropped during replay.
	 */
	openSse(client: SseClient, since: number | null, now: number): boolean {
		this.sse.add(client);
		if (!client.write(`retry: 3000\n: connected latest_id=${this.latestId()}\n\n`)) return this.dropSse(client);
		if (since === null) return true;
		this.prune(now);
		const oldest = this.oldestId();
		if (oldest !== null && since < oldest - 1) {
			client.write(`event: cursor_expired\ndata: {"since":${since},"oldest_id":${oldest}}\n\n`);
		}
		let cursor = since;
		let sent = 0;
		for (;;) {
			const page = this.eventsAfter(cursor, 200);
			if (page.length === 0) break;
			for (const event of page) {
				cursor = event.id;
				if (!matches(client.grant, client.subscription, event)) continue;
				if (sent >= MAX_REPLAY) {
					client.write(`event: replay_truncated\ndata: {"resume_from":${client.lastId}}\n\n`);
					return this.dropSse(client);
				}
				if (!client.write(sseFrame(event))) return this.dropSse(client);
				client.lastId = event.id;
				sent += 1;
			}
			if (page.length < 200) break;
		}
		return true;
	}

	private dropSse(client: SseClient): false {
		this.sse.delete(client);
		try {
			client.close();
		} catch {
			// already closed
		}
		return false;
	}

	closeSse(client: SseClient): void {
		this.sse.delete(client);
	}

	private deliverToSse(client: SseClient, events: StoredEvent[], now: number): void {
		if (this.expired(client.grant, now)) {
			client.write(`event: reauthenticate\ndata: {}\n\n`);
			this.dropSse(client);
			return;
		}
		for (const event of events) {
			if (!matches(client.grant, client.subscription, event)) continue;
			// `write` returns false when the stream's queue is full: the client is
			// too slow. It reconnects with Last-Event-ID and replays.
			if (!client.write(sseFrame(event))) {
				this.dropSse(client);
				return;
			}
			client.lastId = event.id;
		}
	}

	/** Heartbeat for SSE clients, and expiry for both kinds. */
	tick(now: number): void {
		for (const client of [...this.sse]) {
			if (this.expired(client.grant, now)) {
				client.write(`event: reauthenticate\ndata: {}\n\n`);
				this.dropSse(client);
			} else if (!client.write(`: keepalive\n\n`)) {
				this.dropSse(client);
			}
		}
		for (const ws of this.host.getWebSockets()) {
			const a = this.attachmentOf(ws);
			if (a && this.expired(a.grant, now)) ws.close(CLOSE_REAUTHENTICATE, "authorization expired; reconnect");
		}
	}
}
