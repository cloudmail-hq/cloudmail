import { Tapetide, type ClientOptions } from "../src/index.js";

export interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

export type Responder = (call: Call, n: number) => Response | Promise<Response> | Error;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

/** A fetch that records calls and answers from `responders` in order (the last repeats). */
export function mockFetch(...responders: Responder[]) {
	const calls: Call[] = [];
	const fetch = async (input: string, init: RequestInit): Promise<Response> => {
		const headers: Record<string, string> = {};
		new Headers(init.headers).forEach((v, k) => (headers[k] = v));
		const call: Call = {
			url: input,
			method: init.method ?? "GET",
			headers,
			body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
		};
		calls.push(call);
		const responder = responders[Math.min(calls.length - 1, responders.length - 1)]!;
		const out = await responder(call, calls.length);
		if (out instanceof Error) throw out;
		return out;
	};
	return { fetch, calls };
}

export function client(fetch: ClientOptions["fetch"], extra: Partial<ClientOptions> = {}): Tapetide {
	return new Tapetide({
		baseUrl: "https://mail.example.com/",
		token: "ttk_abc_secret",
		fetch,
		sleep: async () => {},
		...extra,
	});
}
