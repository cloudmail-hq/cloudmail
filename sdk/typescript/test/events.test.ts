import { describe, expect, it } from "vitest";
import { SseParser, StreamRevokedError, type ControlFrame, type StreamEvent, type WebSocketLike } from "../src/index.js";
// The server's frame builders, so the client parses what the hub writes.
import { eventFrame, sseFrame, CLOSE_CREDENTIAL_REVOKED } from "../../../workers/lib/events-hub";
import { client } from "./helpers.js";

const payload = (id: number) => JSON.stringify({ id: `evt_${id}`, type: "message.received", created_at: "t", mailbox: "s@example.com", data: { subject: `#${id}` } });

/** A streaming SSE response from string chunks. */
function sse(chunks: string[], status = 200): Response {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const c of chunks) controller.enqueue(enc.encode(c));
				controller.close();
			},
		}),
		{ status, headers: { "Content-Type": "text/event-stream" } },
	);
}

describe("SseParser", () => {
	it("parses the hub's frames split across arbitrary chunks", () => {
		const text = `retry: 3000\n: connected latest_id=9\n\n${sseFrame({ id: 10, type: "message.received", payload: payload(10) })}event: subscription_revoked\ndata: {"mailbox":"x@example.com"}\n\n`;
		const p = new SseParser();
		const out = [];
		for (let i = 0; i < text.length; i += 7) out.push(...p.push(text.slice(i, i + 7)));
		expect(out).toEqual([
			{ id: "10", event: "message.received", data: payload(10) },
			{ event: "subscription_revoked", data: '{"mailbox":"x@example.com"}' },
		]);
	});

	it("handles CRLF and multi-line data", () => {
		expect(new SseParser().push("data: a\r\ndata: b\r\n\r\n")).toEqual([{ event: "message", data: "a\nb" }]);
	});
});

describe("events.subscribe over SSE", () => {
	it("delivers events, reconnects with since + Last-Event-ID, and skips replay overlap", async () => {
		const urls: string[] = [];
		const lastIds: (string | undefined)[] = [];
		let n = 0;
		const fetch = async (url: string, init: RequestInit) => {
			urls.push(url);
			lastIds.push(new Headers(init.headers).get("last-event-id") ?? undefined);
			n++;
			if (n === 1) return sse([sseFrame({ id: 5, type: "message.received", payload: payload(5) }), sseFrame({ id: 6, type: "message.received", payload: payload(6) })]);
			if (n === 2) return sse([sseFrame({ id: 6, type: "message.received", payload: payload(6) }), sseFrame({ id: 7, type: "message.received", payload: payload(7) })]);
			return sse(["event: credential_revoked\ndata: {}\n\n"]);
		};
		const got: StreamEvent[] = [];
		const errors: [Error, boolean][] = [];
		const t = client(fetch);
		const sub = t.events.subscribe(
			{ mailboxes: ["s@example.com"], events: ["message.received"], since: 4, sleep: async () => {}, onError: (e, i) => errors.push([e, i.fatal]) },
			(e) => void got.push(e),
		);
		await sub.closed;
		expect(got.map((e) => e.id)).toEqual([5, 6, 7]);
		expect(got[0]!.event.data.subject).toBe("#5");
		expect(sub.lastEventId).toBe(7);
		expect(urls[0]).toBe("https://mail.example.com/api/v1/events/sse?mailbox=s%40example.com&event=message.received&since=4");
		expect(urls[1]).toContain("since=6");
		expect(urls[2]).toContain("since=7");
		expect(lastIds).toEqual(["4", "6", "7"]);
		expect(errors.at(-1)![0]).toBeInstanceOf(StreamRevokedError);
		expect(errors.at(-1)![1]).toBe(true);
	});

	it("reports subscription_revoked and keeps going", async () => {
		let n = 0;
		const controls: ControlFrame[] = [];
		const fetch = async () =>
			++n === 1
				? sse([`event: subscription_revoked\ndata: {"mailbox":"old@example.com"}\n\n`, sseFrame({ id: 1, type: "message.received", payload: payload(1) })])
				: new Response(null, { status: 401 });
		const got: number[] = [];
		const sub = client(fetch).events.subscribe({ sleep: async () => {}, onControl: (f) => void controls.push(f) }, (e) => void got.push(e.id));
		await sub.closed;
		expect(controls).toEqual([{ type: "subscription_revoked", mailbox: "old@example.com" }]);
		expect(got).toEqual([1]);
		expect(n).toBe(2);
	});

	it("retries transport errors and 5xx with backoff, stops on 403", async () => {
		const sleeps: number[] = [];
		let n = 0;
		const fetch = async () => {
			n++;
			if (n === 1) throw new TypeError("network down");
			if (n === 2) return new Response("busy", { status: 503 });
			return new Response(null, { status: 403 });
		};
		const sub = client(fetch).events.subscribe({ sleep: async (ms) => void sleeps.push(ms), minReconnectMs: 100, maxReconnectMs: 1000, onError: () => {} }, () => {});
		await sub.closed;
		expect(n).toBe(3);
		expect(sleeps).toHaveLength(2);
		expect(sleeps[0]).toBeGreaterThanOrEqual(50);
		expect(sleeps[1]).toBeGreaterThanOrEqual(100);
	});

	it("resumes from replay_truncated", async () => {
		const urls: string[] = [];
		let n = 0;
		const fetch = async (url: string) => {
			urls.push(url);
			return ++n === 1 ? sse([`event: replay_truncated\ndata: {"resume_from":1000}\n\n`]) : new Response(null, { status: 401 });
		};
		await client(fetch).events.subscribe({ sleep: async () => {}, onError: () => {} }, () => {}).closed;
		expect(urls[1]).toContain("since=1000");
	});

	it("close() ends the subscription", async () => {
		const fetch = async (_url: string, init: RequestInit) =>
			new Response(
				new ReadableStream({
					start(controller) {
						init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
					},
				}),
				{ status: 200 },
			);
		const sub = client(fetch).events.subscribe({ sleep: async () => {} }, () => {});
		await new Promise((r) => setTimeout(r, 5));
		sub.close();
		await sub.closed;
	});
});

/** A scripted fake socket. */
class FakeSocket implements WebSocketLike {
	static instances: FakeSocket[] = [];
	sent: string[] = [];
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	constructor(
		readonly url: string,
		readonly headers: Record<string, string>,
	) {
		FakeSocket.instances.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close(code = 1000) {
		this.onclose?.({ code });
	}
	open() {
		this.onopen?.({});
	}
	frame(text: string) {
		this.onmessage?.({ data: text });
	}
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("events.subscribe over WebSocket", () => {
	it("subscribes with headers, reconnects with since, and stops on close 4401", async () => {
		FakeSocket.instances = [];
		const got: number[] = [];
		const controls: string[] = [];
		const errors: Error[] = [];
		const sub = client(async () => new Response(null)).events.subscribe(
			{
				transport: "websocket",
				webSocket: (url, headers) => new FakeSocket(url, headers),
				mailboxes: ["s@example.com"],
				sleep: async () => {},
				onControl: (f) => void controls.push(f.type),
				onError: (e) => void errors.push(e),
			},
			(e) => void got.push(e.id),
		);
		await tick();
		const first = FakeSocket.instances[0]!;
		expect(first.url).toBe("wss://mail.example.com/api/v1/events/stream");
		expect(first.headers.Authorization).toBe("Bearer ttk_abc_secret");
		first.open();
		expect(JSON.parse(first.sent[0]!)).toEqual({ type: "subscribe", mailboxes: ["s@example.com"] });
		first.frame(JSON.stringify({ type: "hello", latest_id: 3 }));
		first.frame(eventFrame({ id: 3, payload: payload(3) }));
		first.frame(eventFrame({ id: 4, payload: payload(4) }));
		first.close(1013); // overflow: reconnect
		await tick();
		await tick();

		const second = FakeSocket.instances[1]!;
		expect(second.url).toBe("wss://mail.example.com/api/v1/events/stream?since=4");
		second.open();
		second.frame(eventFrame({ id: 4, payload: payload(4) })); // replay overlap, skipped
		second.frame(eventFrame({ id: 5, payload: payload(5) }));
		second.frame(JSON.stringify({ type: "subscription_revoked", mailbox: "s@example.com" }));
		second.frame(JSON.stringify({ type: "credential_revoked" }));
		second.close(CLOSE_CREDENTIAL_REVOKED);
		await sub.closed;

		expect(got).toEqual([3, 4, 5]);
		expect(controls).toEqual(["hello", "subscription_revoked", "credential_revoked"]);
		expect(FakeSocket.instances).toHaveLength(2);
		expect(errors.at(-1)).toBeInstanceOf(StreamRevokedError);
	});

	it("treats a bare 4401 close as revoked", async () => {
		FakeSocket.instances = [];
		const sub = client(async () => new Response(null)).events.subscribe(
			{ transport: "websocket", webSocket: (u, h) => new FakeSocket(u, h), sleep: async () => {}, onError: () => {} },
			() => {},
		);
		await tick();
		FakeSocket.instances[0]!.close(4401);
		await sub.closed;
		expect(FakeSocket.instances).toHaveLength(1);
	});
});
