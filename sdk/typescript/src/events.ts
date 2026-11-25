/**
 * Realtime event stream client (docs/realtime.md).
 *
 * `subscribe()` keeps one stream open, delivers each event once, and survives
 * drops: it remembers the highest event id it handed you and reconnects with
 * `since=<id>`, so the server replays what was missed (24 hours retained).
 *
 * Two transports:
 * - `"sse"` (default): `GET /api/v1/events/sse` over `fetch`, which can send
 *   the bearer token from any runtime.
 * - `"websocket"`: `GET /api/v1/events/stream`. Pass `webSocket`, a factory
 *   that opens a socket with the given headers (Node's `ws` package, or
 *   undici's `WebSocket` with `{ headers }`). Browsers cannot set headers on a
 *   WebSocket; there the session cookie authenticates instead.
 *
 * It stops for good, without reconnecting, when the credential is revoked (WS
 * close 4401, SSE `credential_revoked`, or HTTP 401/403), and calls `onError`
 * with a `StreamRevokedError`. A `subscription_revoked` frame means one mailbox
 * left your grant; it is reported through `onControl` and the stream goes on.
 */

import type { HttpClient } from "./http.js";
import type { WebhookEvent, WebhookEventType } from "./types.js";
import { TapetideError } from "./errors.js";

export const CLOSE_CREDENTIAL_REVOKED = 4401;
export const CLOSE_REAUTHENTICATE = 4001;
export const CLOSE_AUTH_UNAVAILABLE = 4503;
export const CLOSE_SLOW_CONSUMER = 1013;

export interface SubscribeOptions {
	/** Mailboxes to follow; omit for every mailbox you can read. */
	mailboxes?: string[];
	/** Event types; omit for all. */
	events?: (WebhookEventType | (string & {}))[];
	/** Replay events after this id (e.g. the last id you processed). */
	since?: number;
	transport?: "sse" | "websocket";
	/** Required for `transport: "websocket"` outside a browser. */
	webSocket?: WebSocketFactory;
	/** Reconnect delay bounds in ms (default 1 000 .. 30 000). */
	minReconnectMs?: number;
	maxReconnectMs?: number;
	/** Control frames: hello, subscribed, replayed, subscription_revoked, cursor_expired, … */
	onControl?: (frame: ControlFrame) => void;
	/** Every error; fatal ones end the subscription (`subscription.closed` resolves). */
	onError?: (error: Error, info: { fatal: boolean }) => void;
	/** Injectable sleep, for tests. */
	sleep?: (ms: number) => Promise<void>;
}

export interface StreamEvent {
	id: number;
	event: WebhookEvent;
}

export interface ControlFrame {
	type: string;
	[key: string]: unknown;
}

export interface Subscription {
	/** Stop and close the connection. */
	close(): void;
	/** Highest event id delivered so far (persist it to resume later). */
	readonly lastEventId: number | null;
	/** Resolves when the subscription ends (closed or fatal error). */
	readonly closed: Promise<void>;
}

/** The credential was revoked or refused; reconnecting cannot help. */
export class StreamRevokedError extends TapetideError {
	override name = "StreamRevokedError";
}

/** Minimal WebSocket surface the client uses. */
export interface WebSocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: { code: number; reason?: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

// ── SSE parsing ─────────────────────────────────────────────────────

export interface SseMessage {
	id?: string;
	event: string;
	data: string;
}

/**
 * Incremental `text/event-stream` parser. Feed chunks; complete messages come
 * out. Comment lines (`:`) and `retry:` are ignored.
 */
export class SseParser {
	private buffer = "";
	private id: string | undefined;
	private event = "";
	private data: string[] = [];

	push(chunk: string): SseMessage[] {
		this.buffer += chunk;
		const out: SseMessage[] = [];
		let nl: number;
		while ((nl = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
			const line = this.buffer.slice(0, nl);
			const sepLen = this.buffer.startsWith("\r\n", nl) ? 2 : 1;
			this.buffer = this.buffer.slice(nl + sepLen);
			if (line === "") {
				if (this.data.length || this.event) {
					out.push({ ...(this.id !== undefined ? { id: this.id } : {}), event: this.event || "message", data: this.data.join("\n") });
				}
				this.id = undefined;
				this.event = "";
				this.data = [];
				continue;
			}
			if (line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "data") this.data.push(value);
			else if (field === "event") this.event = value;
			else if (field === "id") this.id = value;
		}
		return out;
	}
}

// ── client ──────────────────────────────────────────────────────────

/** SSE control events that end the stream for good. */
const SSE_FATAL = new Set(["credential_revoked"]);

export class EventsResource {
	constructor(private readonly http: HttpClient) {}

	/**
	 * Follow events until `close()` (or a revoked credential). `onEvent` may be
	 * async; events are delivered one at a time, in id order.
	 */
	subscribe(options: SubscribeOptions, onEvent: (event: StreamEvent) => void | Promise<void>): Subscription {
		const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		const minDelay = options.minReconnectMs ?? 1000;
		const maxDelay = options.maxReconnectMs ?? 30_000;
		let lastId: number | null = options.since ?? null;
		let stopped = false;
		let abort: AbortController | null = null;
		let socket: WebSocketLike | null = null;
		let resolveClosed!: () => void;
		const closed = new Promise<void>((r) => (resolveClosed = r));

		const report = (error: Error, fatal: boolean) => options.onError?.(error, { fatal });

		const deliver = async (id: number, event: WebhookEvent) => {
			if (lastId !== null && id <= lastId) return; // replay overlap
			await onEvent({ id, event });
			lastId = id;
		};

		/** One connection. Resolves with "retry" (reconnect) or "stop". */
		const runSse = async (): Promise<"retry" | "stop"> => {
			abort = new AbortController();
			const query: Record<string, string | number | string[]> = {};
			if (options.mailboxes?.length) query.mailbox = options.mailboxes;
			if (options.events?.length) query.event = options.events as string[];
			if (lastId !== null) query.since = lastId;
			const url = this.http.url("/api/v1/events/sse", undefined, query);
			const res = await this.http.rawFetch(url, {
				method: "GET",
				headers: { Accept: "text/event-stream", ...(lastId !== null ? { "Last-Event-ID": String(lastId) } : {}) },
				signal: abort.signal,
			});
			if (res.status === 401 || res.status === 403) {
				report(new StreamRevokedError(`Event stream refused: HTTP ${res.status}`, { status: res.status }), true);
				return "stop";
			}
			if (!res.ok || !res.body) {
				report(new TapetideError(`Event stream failed: HTTP ${res.status}`, { status: res.status }), false);
				return "retry";
			}
			const parser = new SseParser();
			const decoder = new TextDecoder();
			const reader = res.body.getReader();
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return "retry";
					for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
						if (msg.id !== undefined && /^\d+$/.test(msg.id)) {
							await deliver(Number(msg.id), JSON.parse(msg.data) as WebhookEvent);
							continue;
						}
						const data = msg.data ? safeJson(msg.data) : {};
						const frame = { type: msg.event, ...(data && typeof data === "object" ? data : {}) } as ControlFrame;
						options.onControl?.(frame);
						if (SSE_FATAL.has(msg.event)) {
							report(new StreamRevokedError("Credential revoked", { status: 401, code: "credential_revoked" }), true);
							return "stop";
						}
						if (msg.event === "replay_truncated" && typeof frame.resume_from === "number") {
							lastId = Math.max(lastId ?? 0, frame.resume_from);
						}
					}
				}
			} finally {
				reader.cancel().catch(() => {});
			}
		};

		const runWs = (): Promise<"retry" | "stop"> =>
			new Promise((resolve) => {
				const factory = options.webSocket;
				const query: Record<string, number> = {};
				if (lastId !== null) query.since = lastId;
				const url = this.http.url("/api/v1/events/stream", undefined, query).replace(/^http/, "ws");
				let ws: WebSocketLike;
				try {
					ws = factory
						? factory(url, this.http.authHeaders())
						: (new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url) as WebSocketLike);
				} catch (e) {
					report(e as Error, false);
					resolve("retry");
					return;
				}
				socket = ws;
				// Events are handled one at a time even though frames arrive freely.
				let chain: Promise<void> = Promise.resolve();
				let fatal = false;
				ws.onopen = () => {
					ws.send(
						JSON.stringify({
							type: "subscribe",
							...(options.mailboxes?.length ? { mailboxes: options.mailboxes } : {}),
							...(options.events?.length ? { events: options.events } : {}),
						}),
					);
				};
				ws.onmessage = (m) => {
					const frame = safeJson(typeof m.data === "string" ? m.data : String(m.data)) as ControlFrame | null;
					if (!frame || typeof frame.type !== "string") return;
					if (frame.type === "event" && typeof frame.id === "number") {
						const id = frame.id;
						const event = frame.event as WebhookEvent;
						chain = chain.then(() => deliver(id, event)).catch((e) => report(e as Error, false));
						return;
					}
					if (frame.type === "credential_revoked") fatal = true;
					if (frame.type === "replay_truncated" && typeof frame.resume_from === "number") {
						const resume = frame.resume_from;
						chain = chain.then(() => {
							lastId = Math.max(lastId ?? 0, resume);
						});
					}
					options.onControl?.(frame);
				};
				ws.onerror = () => {};
				ws.onclose = (ev) => {
					socket = null;
					void chain.then(() => {
						if (fatal || ev.code === CLOSE_CREDENTIAL_REVOKED) {
							report(new StreamRevokedError("Credential revoked", { status: 401, code: "credential_revoked" }), true);
							resolve("stop");
						} else {
							resolve("retry");
						}
					});
				};
			});

		void (async () => {
			let failures = 0;
			while (!stopped) {
				let outcome: "retry" | "stop";
				const started = Date.now();
				try {
					outcome = options.transport === "websocket" ? await runWs() : await runSse();
				} catch (e) {
					if (stopped) break;
					report(e as Error, false);
					outcome = "retry";
				}
				if (outcome === "stop" || stopped) break;
				// A connection that lasted a while resets the backoff.
				failures = Date.now() - started > 60_000 ? 0 : failures + 1;
				const delay = Math.min(maxDelay, minDelay * 2 ** Math.max(0, failures - 1));
				await sleep(Math.round(delay / 2 + Math.random() * (delay / 2)));
			}
			stopped = true;
			resolveClosed();
		})();

		return {
			close() {
				stopped = true;
				abort?.abort();
				const s = socket as WebSocketLike | null;
				s?.close(1000, "client closed");
			},
			get lastEventId() {
				return lastId;
			},
			closed,
		};
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
