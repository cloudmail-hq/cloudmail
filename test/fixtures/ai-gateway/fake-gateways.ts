// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A fake network serving two gateways, dispatching on URL:
 *
 *   https://oai.gw.example/v1   OpenAI Chat Completions (+ /models, /embeddings)
 *   https://anth.gw.example/v1  Anthropic Messages (+ paginated /models)
 *
 * Each request is recorded (url, method, headers, parsed body). `override`
 * lets a test answer a request itself (500s, 302s, echoing 400s).
 */

export const OAI_BASE = "https://oai.gw.example/v1";
export const ANTH_BASE = "https://anth.gw.example/v1";
export const OAI_TOKEN = "sk-oai-synthetic-token-9f3a";
export const ANTH_TOKEN = "anth-synthetic-token-7c2e";
export const OAI_CHAT = "gpt-4o-mini";
export const OAI_EMBED = "text-embedding-3-small";
export const ANTH_CHAT = "claude-test-sonnet";

export interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: any;
}

const sse = (events: string[]) =>
	new Response(events.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const data = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const named = (event: string, v: unknown) => `event: ${event}\ndata: ${JSON.stringify(v)}\n\n`;

function hasToolResult(body: any, wire: "openai" | "anthropic"): boolean {
	const msgs: any[] = body?.messages ?? [];
	if (wire === "openai") return msgs.some((m) => m.role === "tool");
	return msgs.some((m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool_result"));
}

function toolResultText(body: any, wire: "openai" | "anthropic"): string {
	const msgs: any[] = body?.messages ?? [];
	if (wire === "openai") return String(msgs.find((m) => m.role === "tool")?.content ?? "");
	for (const m of msgs) {
		if (!Array.isArray(m.content)) continue;
		const p = m.content.find((x: any) => x.type === "tool_result");
		if (p) return typeof p.content === "string" ? p.content : JSON.stringify(p.content);
	}
	return "";
}

function wantsJson(body: any): boolean {
	return !!body?.response_format;
}

function openAi(path: string, body: any): Response {
	if (path === "/models") {
		return Response.json({
			object: "list",
			data: [
				{ id: OAI_CHAT, object: "model", owned_by: "openai" },
				{ id: "dall-e-3", object: "model", owned_by: "openai" },
				{ id: OAI_EMBED, object: "model", owned_by: "openai" },
			],
		});
	}
	if (path === "/embeddings") {
		const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
		return Response.json({
			object: "list",
			data: inputs.map((_, i) => ({ object: "embedding", index: i, embedding: Array.from({ length: 1024 }, (_, j) => (i + 1) * 0.001 * (j % 7)) })),
			model: body.model,
			usage: { prompt_tokens: 5 * inputs.length, total_tokens: 5 * inputs.length },
		});
	}
	if (path === "/chat/completions") {
		const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
		const forcedTool = body.tool_choice === "required" || (typeof body.tool_choice === "object" && body.tool_choice);
		const firstTool = body.tools?.[0]?.function?.name;
		const wantTool = !!firstTool && !hasToolResult(body, "openai");
		if (body.stream) {
			const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: body.model };
			const events: string[] = [];
			if (wantTool) {
				events.push(data({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: firstTool, arguments: "" } }] }, finish_reason: null }] }));
				events.push(data({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] }, finish_reason: null }] }));
				events.push(data({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"invoices"}' } }] }, finish_reason: null }] }));
				events.push(data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
			} else {
				const text = hasToolResult(body, "openai") ? `Found: ${toolResultText(body, "openai")}` : "Hello from OAI";
				events.push(data({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text.slice(0, 6) }, finish_reason: null }] }));
				events.push(data({ ...base, choices: [{ index: 0, delta: { content: text.slice(6) }, finish_reason: null }] }));
				events.push(data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
			}
			if (body.stream_options?.include_usage) events.push(data({ ...base, choices: [], usage }));
			events.push("data: [DONE]\n\n");
			return sse(events);
		}
		const message =
			forcedTool && firstTool
				? { role: "assistant", content: null, tool_calls: [{ id: "call_p", type: "function", function: { name: firstTool, arguments: '{"value":"probe"}' } }] }
				: wantsJson(body)
					? { role: "assistant", content: '{"ok": true}' }
					: { role: "assistant", content: "OK" };
		return Response.json({
			id: "chatcmpl-2",
			object: "chat.completion",
			created: 1,
			model: body.model,
			choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
			usage,
		});
	}
	return Response.json({ error: { message: "not found" } }, { status: 404 });
}

function anthropic(path: string, url: URL, body: any): Response {
	if (path === "/models") {
		const after = url.searchParams.get("after_id");
		if (!after) {
			return Response.json({
				data: [{ id: ANTH_CHAT, display_name: "Claude Test Sonnet", type: "model", created_at: "2026-01-01T00:00:00Z" }],
				has_more: true,
				first_id: ANTH_CHAT,
				last_id: ANTH_CHAT,
			});
		}
		return Response.json({
			data: [{ id: "claude-test-haiku", display_name: "Claude Test Haiku", type: "model", created_at: "2026-01-01T00:00:00Z" }],
			has_more: false,
			first_id: "claude-test-haiku",
			last_id: "claude-test-haiku",
		});
	}
	if (path === "/messages") {
		const usage = { input_tokens: 13, output_tokens: 9 };
		const tools: any[] = body.tools ?? [];
		const forced = body.tool_choice?.type === "any" || body.tool_choice?.type === "tool";
		const jsonTool = tools.find((t) => t.name === "json");
		const userTool = tools.find((t) => t.name !== "json");
		const wantTool = !!userTool && !hasToolResult(body, "anthropic");
		if (body.stream) {
			const events: string[] = [];
			events.push(named("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }));
			if (wantTool) {
				events.push(named("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: userTool.name, input: {} } }));
				events.push(named("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":' } }));
				events.push(named("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"invoices"}' } }));
				events.push(named("content_block_stop", { type: "content_block_stop", index: 0 }));
				events.push(named("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }));
			} else {
				const text = hasToolResult(body, "anthropic") ? `Found: ${toolResultText(body, "anthropic")}` : "Hello from Anthropic";
				events.push(named("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
				events.push(named("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 6) } }));
				events.push(named("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(6) } }));
				events.push(named("content_block_stop", { type: "content_block_stop", index: 0 }));
				events.push(named("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }));
			}
			events.push(named("message_stop", { type: "message_stop" }));
			return sse(events);
		}
		let content: any[];
		let stop = "end_turn";
		if (jsonTool) {
			content = [{ type: "tool_use", id: "toolu_j", name: "json", input: { ok: true } }];
			stop = "tool_use";
		} else if (forced && userTool) {
			content = [{ type: "tool_use", id: "toolu_p", name: userTool.name, input: { value: "probe" } }];
			stop = "tool_use";
		} else if (body.output_config?.format) {
			content = [{ type: "text", text: '{"ok": true}' }];
		} else {
			content = [{ type: "text", text: "OK" }];
		}
		return Response.json({ id: "msg_2", type: "message", role: "assistant", model: body.model, content, stop_reason: stop, stop_sequence: null, usage });
	}
	return Response.json({ type: "error", error: { type: "not_found_error", message: "not found" } }, { status: 404 });
}

export function fakeNetwork() {
	const calls: Recorded[] = [];
	let override: ((r: Recorded) => Response | Promise<Response> | null | undefined) | null = null;
	const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const req = input instanceof Request ? input : null;
		const url = req ? req.url : String(input);
		const method = (init.method ?? req?.method ?? "GET").toUpperCase();
		const headers: Record<string, string> = {};
		new Headers(init.headers ?? req?.headers).forEach((v, k) => (headers[k] = v));
		const rawBody = init.body !== undefined && init.body !== null ? String(init.body) : req ? await req.clone().text() : "";
		let body: any = null;
		try {
			body = rawBody ? JSON.parse(rawBody) : null;
		} catch {
			body = rawBody;
		}
		const rec: Recorded = { url, method, headers, body };
		calls.push(rec);
		if (override) {
			const out = await override(rec);
			if (out) return out;
		}
		const u = new URL(url);
		if (url.startsWith(OAI_BASE)) return openAi(u.pathname.slice("/v1".length), body);
		if (url.startsWith(ANTH_BASE)) return anthropic(u.pathname.slice("/v1".length), u, body);
		return new Response("no route", { status: 599 });
	}) as typeof fetch;
	return {
		fetch: fetchFn,
		calls,
		setOverride(f: typeof override) {
			override = f;
		},
		reset() {
			calls.length = 0;
			override = null;
		},
	};
}
