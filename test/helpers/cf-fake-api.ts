/**
 * A fake Cloudflare API for the connection tests: routes by method + path
 * (query string ignored unless a route includes it), records every call.
 */

export interface FakeRoute {
	status?: number;
	body: unknown;
}

export function cfOk(result: unknown, extra: Record<string, unknown> = {}): FakeRoute {
	return { body: { success: true, errors: [], result, ...extra } };
}

export function cfErr(status: number, message = "Authentication error", code = 10000): FakeRoute {
	return { status, body: { success: false, errors: [{ code, message }], result: null } };
}

export function fakeCfApi(routes: Record<string, FakeRoute | ((init: RequestInit) => FakeRoute)>) {
	const calls: { method: string; path: string; auth: string | null; body?: string }[] = [];
	const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/client\/v4/, "");
		const method = (init.method ?? "GET").toUpperCase();
		const auth = new Headers(init.headers).get("authorization");
		calls.push({ method, path: path + url.search, auth, body: typeof init.body === "string" ? init.body : undefined });
		const entry = routes[`${method} ${path}${url.search}`] ?? routes[`${method} ${path}`];
		const route = typeof entry === "function" ? entry(init) : entry;
		if (!route) return new Response(JSON.stringify({ success: false, errors: [{ message: "no route" }] }), { status: 404 });
		return new Response(JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { impl, calls };
}

export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const ZONE = "fedcba9876543210fedcba9876543210";

/** Every probe answering OK, for a user token on one account. */
export function healthyRoutes(extra: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
	return {
		"GET /user/tokens/verify": cfOk({ id: "tok", status: "active" }),
		"GET /accounts": cfOk([{ id: ACCOUNT, name: "Acme" }]),
		"GET /zones": cfOk([{ id: ZONE, name: "example.com" }], { result_info: { total_count: 3 } }),
		[`GET /zones/${ZONE}/dns_records`]: cfOk([]),
		[`GET /zones/${ZONE}/email/routing`]: cfOk({ enabled: true }),
		[`GET /zones/${ZONE}/email/routing/rules/catch_all`]: cfOk({ enabled: true, matchers: [], actions: [] }),
		[`GET /zones/${ZONE}/email/sending/subdomains`]: cfOk([]),
		[`GET /accounts/${ACCOUNT}/vectorize/v2/indexes`]: cfOk([]),
		[`GET /accounts/${ACCOUNT}/workers/scripts`]: cfOk([{ id: "tapetide-agentic-inbox" }]),
		"POST /graphql": { body: { data: { viewer: { accounts: [{ accountTag: ACCOUNT }], zones: [{}] } }, errors: null } },
		...extra,
	};
}
