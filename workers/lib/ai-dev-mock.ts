// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A deterministic stand-in for the Workers AI binding, for local development.
 *
 * Workers AI only runs remotely, so `vite dev` without a Cloudflare login has
 * no model to call. With `LOCAL_AI_MOCK=1` in a local dev config, summaries
 * are produced from the message text itself (first sentence, first lines), so
 * the whole pipeline (queue, alarm, storage, UI) can be exercised offline.
 * The agent panel, auto-draft and nudge get a scripted two-step turn (one
 * `list_emails` call, then streamed text) so streaming and tools can be too.
 *
 * Gated on `import.meta.env.DEV`, which is a compile-time `false` in a
 * production build: setting the variable in production does nothing.
 */


function firstSentence(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	const m = /^(.{10,}?[.!?])(\s|$)/.exec(t);
	return (m ? m[1]! : t).slice(0, max);
}

function conversationOf(content: string): string {
	return content.replace(/<\/?conversation>/g, "").trim();
}

type ChatInput = {
	messages?: { role: string; content: unknown; tool_calls?: unknown[] }[];
	tools?: { function?: { name?: string } }[];
	stream?: boolean;
};

/** One SSE event in the Workers AI run-path chat-completions shape. */
function sse(data: unknown): string {
	return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

/**
 * The agent's model call, as `createAI` (agents/models/ai-sdk) makes it:
 * `run(model, chatCompletionsBody, { returnRawResponse: true, ... })`, which
 * answers with a raw `Response`. A deterministic two-step turn so the panel's
 * streaming and tool path can be exercised offline:
 *
 * - no tool result yet and `list_emails` offered: call `list_emails`;
 * - otherwise: a short streamed text answer naming how many tool results it saw.
 */
function agentResponse(input: ChatInput): Response {
	const messages = input.messages ?? [];
	// Tool results since the latest user message: this turn's, not history's.
	const lastUser = messages.map((m) => m.role).lastIndexOf("user");
	const toolResults = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
	const offersList = (input.tools ?? []).some((t) => t.function?.name === "list_emails");
	const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
		id: "mock",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, finish_reason: finish }],
	});
	const events: unknown[] = [];
	if (toolResults === 0 && offersList) {
		events.push(
			chunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_mock_1",
						type: "function",
						function: { name: "list_emails", arguments: JSON.stringify({ folder: "inbox", limit: 5, page: 1 }) },
					},
				],
			}),
			chunk({}, "tool_calls"),
		);
	} else {
		const words = `(mock) I checked the inbox with ${toolResults} tool call${toolResults === 1 ? "" : "s"}. Nothing needs a reply right now.`.split(" ");
		events.push(chunk({ role: "assistant", content: "" }));
		for (const [i, w] of words.entries()) events.push(chunk({ content: i === 0 ? w : ` ${w}` }));
		events.push(chunk({}, "stop"));
	}
	events.push({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, "[DONE]");

	if (input.stream) {
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				for (const e of events) {
					controller.enqueue(enc.encode(sse(e)));
					// Spread the deltas out so the client visibly streams.
					await new Promise((r) => setTimeout(r, 40));
				}
				controller.close();
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	}
	// Non-streaming (auto-draft, nudge): one completion with the same content.
	const calls = toolResults === 0 && offersList;
	return Response.json({
		id: "mock",
		object: "chat.completion",
		choices: [
			{
				index: 0,
				finish_reason: calls ? "tool_calls" : "stop",
				message: calls
					? {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_mock_1",
									type: "function",
									function: { name: "list_emails", arguments: JSON.stringify({ folder: "inbox", limit: 5, page: 1 }) },
								},
							],
						}
					: { role: "assistant", content: "(mock) Thanks for your note. I will follow up shortly." },
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

const mock = {
	async run(_model: string, input: ChatInput, options?: { returnRawResponse?: boolean }) {
		if (options?.returnRawResponse) return agentResponse(input);
		const system = String(input.messages?.[0]?.content ?? "");
		const user = conversationOf(String(input.messages?.[1]?.content ?? ""));
		if (system.includes("security scanner")) {
			return { response: /ignore (all|your|previous) (previous )?instructions/i.test(user) ? "YES" : "NO" };
		}
		const bodies = user
			.split(/\n\n(?=\[)/)
			.map((part) => part.split("\n").slice(1).join(" "))
			.filter(Boolean);
		const latest = bodies[bodies.length - 1] ?? "";
		if (system.includes('{"line"')) {
			// The summary call: one line plus up to three bullets, from the
			// sentences actually in the thread (newest last), never invented.
			const sentences = bodies
				.flatMap((b) => b.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/))
				.map((s) => s.trim())
				.filter((s) => s.split(" ").length >= 3);
			return {
				response: {
					line: `(mock) ${firstSentence(latest, 100)}`,
					bullets: sentences.slice(-3).map((s) => s.slice(0, 90)),
				},
			};
		}
		return { response: `(mock) ${firstSentence(latest, 100)}` };
	},
};

/**
 * The mock binding when local dev asked for it, else null. The router
 * (`./ai-router.ts`) uses it in place of `env.AI`; nothing else picks a binding.
 */
export function devMockAi(env: { LOCAL_AI_MOCK?: string }): Ai | null {
	if (import.meta.env?.DEV && env.LOCAL_AI_MOCK === "1") return mock as unknown as Ai;
	return null;
}
