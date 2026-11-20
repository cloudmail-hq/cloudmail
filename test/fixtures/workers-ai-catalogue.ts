// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Synthetic rows in the shape of Cloudflare's `GET /accounts/{id}/ai/models/search`.
 * Model names are invented (`@cf/acme/…`) except where a test needs a real
 * default (bge-m3, llama-4-scout) to be listed or not.
 */

type Prop = { property_id: string; value: unknown };

export function row(name: string, task: string, props: Record<string, unknown> = {}) {
	const properties: Prop[] = Object.entries(props).map(([property_id, value]) => ({ property_id, value }));
	return { id: `uuid-${name}`, source: 1, name, description: `Synthetic ${name}`, task: { id: "t", name: task }, tags: [], properties };
}

export const CATALOGUE_ROWS = [
	row("@cf/acme/chat-1.0", "Text Generation", { context_window: "32000" }),
	row("@cf/acme/agent-2.1", "Text Generation", {
		context_window: "262144",
		function_calling: "true",
		reasoning: "true",
		vision: "true",
		price: [
			{ unit: "per M input tokens", price: 0.95, currency: "USD" },
			{ unit: "per M output tokens", price: 4, currency: "USD" },
			{ unit: "per M cached input tokens", price: 0.19, currency: "USD" },
		],
	}),
	row("@cf/acme/agent-2.2", "Text Generation", { context_window: "262144", function_calling: "true" }),
	row("@cf/acme/agent-2.3-code", "Text Generation", { context_window: "262144", function_calling: "true" }),
	row("@cf/meta/llama-4-scout-17b-16e-instruct", "Text Generation", { context_window: "131000", function_calling: "true" }),
	row("@cf/meta/llama-3.1-8b-instruct-fp8", "Text Generation", { context_window: "32000" }),
	row("@cf/acme/beta-lora", "Text Generation", { beta: "true", lora: "true" }),
	row("@cf/baai/bge-m3", "Text Embeddings", { context_window: "60000", price: [{ unit: "per M input tokens", price: 0.012, currency: "USD" }] }),
	row("@cf/acme/embed-768", "Text Embeddings", { output_dimensions: "768" }),
	row("@cf/acme/embed-1024", "Text Embeddings", { output_dimensions: "1024", max_input_tokens: "512" }),
	row("@cf/acme/embed-unknown", "Text Embeddings", {}),
	// Tasks the app never uses are dropped.
	row("@cf/acme/painter", "Text-to-Image", {}),
	row("@cf/acme/whisper", "Automatic Speech Recognition", {}),
];

/** A fake `fetch` for the model search: pages of `perPage`, or a fixed status. */
export function catalogueNetwork(options: { status?: number; rows?: unknown[] } = {}) {
	const calls: string[] = [];
	const rows = options.rows ?? CATALOGUE_ROWS;
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
		calls.push(url.pathname + url.search);
		const auth = new Headers(init?.headers).get("Authorization");
		if (!auth?.startsWith("Bearer ")) return new Response("{}", { status: 401 });
		if (options.status) {
			return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
				status: options.status,
			});
		}
		const perPage = Number(url.searchParams.get("per_page") ?? 100);
		const page = Number(url.searchParams.get("page") ?? 1);
		const slice = rows.slice((page - 1) * perPage, page * perPage);
		return new Response(
			JSON.stringify({ success: true, errors: [], result: slice, result_info: { count: slice.length, page, per_page: perPage, total_count: rows.length } }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** An in-memory Cache API stand-in. */
export function memoryCache() {
	const store = new Map<string, string>();
	return {
		store,
		async match(req: Request | string) {
			const key = typeof req === "string" ? req : req.url;
			const body = store.get(key);
			return body === undefined ? undefined : new Response(body);
		},
		async put(req: Request | string, res: Response) {
			store.set(typeof req === "string" ? req : req.url, await res.text());
		},
	};
}
