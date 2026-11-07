// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The only `fetch` a gateway request goes through: discovery, Test and every
 * model call (it is handed to the AI SDK providers as their `fetch`).
 *
 * On every request, not just at save time:
 *   - the URL is re-checked with `validatePublicHttpsUrl` (purpose
 *     `ai-gateway`) and must sit under the provider's API base, so a
 *     response or SDK quirk can never steer the token to another host;
 *   - `redirect: "manual"`; a 3xx is an error, never followed;
 *   - a timeout, on top of any caller signal;
 *   - response bodies can be capped (discovery reads at most 2 MB).
 *
 * Errors carry a status and a message with every secret removed
 * (`redactGatewayText`). AI SDK errors embed the request URL, headers and
 * body (which is mail), so nothing upstream of this is ever logged whole.
 */

import { redactSecrets } from "../../shared/redact-secrets";
import { validatePublicHttpsUrl } from "../../shared/outbound-url";

export class GatewayFetchError extends Error {
	constructor(
		message: string,
		readonly statusCode: number | null = null,
		readonly code: "blocked" | "redirect" | "timeout" | "too-large" | "network" = "network",
	) {
		super(message);
		this.name = "GatewayFetchError";
	}
}

export interface GatewayFetchOptions {
	/** The provider's API base. Requests outside it are refused. */
	apiBase: string;
	/** This deployment's own hosts, never a gateway. */
	ownHosts: readonly string[];
	allowCustomPorts?: boolean;
	allowCloudflareApi?: boolean;
	timeoutMs?: number;
	/** Plaintext secrets to scrub from any error text. */
	secrets?: readonly string[];
	/** The network. Tests pass a fake. */
	fetch?: typeof fetch;
	/** Local dev only (`LOCAL_FAKE_GATEWAY`); ignored in a production build. */
	devGatewayOrigin?: string;
}

/** Replace secrets and credential-looking strings in text that may reach a log or the UI. */
export function redactGatewayText(text: string, secrets: readonly string[] = []): string {
	let out = String(text ?? "");
	for (const s of secrets) {
		if (s && s.length >= 4) out = out.split(s).join("•••");
	}
	out = out
		.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 •••")
		.replace(/\b(x-api-key|api-key|authorization|cf-aig-authorization)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1$2•••")
		.replace(/\bsk-[\w-]{6,}/g, "•••");
	return redactSecrets(out);
}

/**
 * A short, safe description of any error from a gateway call: status and a
 * redacted message, never the request body, headers or response body.
 */
export function describeGatewayError(e: unknown, secrets: readonly string[] = []): { status: number | null; message: string } {
	const err = e as { statusCode?: unknown; status?: unknown; message?: unknown; name?: unknown; cause?: unknown } | null;
	const status =
		typeof err?.statusCode === "number" ? err.statusCode : typeof err?.status === "number" ? (err.status as number) : null;
	let message = typeof err?.message === "string" ? err.message : String(e);
	// APICallError messages are usually the provider's own error text; keep it short.
	message = message.split("\n")[0]!.slice(0, 240);
	return { status, message: redactGatewayText(message, secrets) };
}

function underBase(url: URL, base: URL): boolean {
	if (url.origin !== base.origin) return false;
	const basePath = base.pathname.replace(/\/+$/, "");
	return url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}

/** A `fetch` for one provider, with the guard applied to every call. */
export function gatewayFetch(options: GatewayFetchOptions): typeof fetch {
	const net = options.fetch ?? globalThis.fetch.bind(globalThis);
	const base = new URL(options.apiBase);
	const secrets = options.secrets ?? [];
	const guarded = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const check = validatePublicHttpsUrl(raw, {
			purpose: "ai-gateway",
			ownHosts: options.ownHosts,
			allowCustomPorts: options.allowCustomPorts,
			allowCloudflareApi: options.allowCloudflareApi,
		});
		if (!check.ok) throw new GatewayFetchError(`Gateway URL refused: ${check.error}`, null, "blocked");
		const url = new URL(check.url);
		if (!underBase(url, base)) throw new GatewayFetchError("Gateway URL refused: outside the provider's base URL.", null, "blocked");

		// Bounds the wait for response headers only. The body (a long streamed
		// answer) is bounded by the caller: the router's per-role timeouts.
		const headersTimeout = new AbortController();
		const timer = setTimeout(() => headersTimeout.abort(), options.timeoutMs ?? 60_000);
		const signal = init.signal ? AbortSignal.any([init.signal, headersTimeout.signal]) : headersTimeout.signal;
		let res: Response;
		try {
				const target = devTarget(url, options.devGatewayOrigin);
			const req = input instanceof Request ? new Request(target, { ...cloneInit(input), ...init, redirect: "manual", signal }) : null;
			res = req ? await net(req) : await net(target, { ...init, redirect: "manual", signal });
		} catch (e) {
			if (headersTimeout.signal.aborted) throw new GatewayFetchError("The gateway did not answer in time.", null, "timeout");
			if ((e as Error)?.name === "AbortError") throw e;
			throw new GatewayFetchError(`Could not reach the gateway: ${redactGatewayText((e as Error)?.message ?? "network error", secrets)}`);
		} finally {
			clearTimeout(timer);
		}
		// workerd returns the 3xx itself; other runtimes return an opaque redirect (status 0).
		if ((res.status >= 300 && res.status < 400) || res.status === 0 || res.type === "opaqueredirect") {
			// Never follow: the Location could be anywhere, and the token would go with it.
			try {
				await res.body?.cancel();
			} catch {
				// ignore
			}
			throw new GatewayFetchError(`The gateway answered with a redirect (${res.status}); redirects are not followed.`, res.status, "redirect");
		}
		return res;
	};
	return guarded as typeof fetch;
}

function cloneInit(r: Request): RequestInit {
	return { method: r.method, headers: r.headers, body: r.body, ...(r.body ? { duplex: "half" } : {}) } as RequestInit;
}

/**
 * Local development only: send requests for the reserved test host
 * `fake-gateway.example` to a fake gateway on this machine
 * (`LOCAL_FAKE_GATEWAY=http://127.0.0.1:8799`). The URL was validated as
 * the public-looking name first. `import.meta.env.DEV` is a compile-time
 * false in a production build, so this branch is not in the deployed Worker.
 */
function devTarget(url: URL, devOrigin: string | undefined): string {
	if (import.meta.env?.DEV && devOrigin && url.hostname === "fake-gateway.example") {
		const local = new URL(devOrigin);
		if (local.hostname === "127.0.0.1" || local.hostname === "localhost") {
			return `${local.origin}${url.pathname}${url.search}`;
		}
	}
	return url.toString();
}

/** Read at most `maxBytes` of a response as JSON. */
export async function readJsonCapped(res: Response, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
	const declared = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await res.body?.cancel();
		throw new GatewayFetchError("The model list is too large.", res.status, "too-large");
	}
	if (!res.body) return null;
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new GatewayFetchError("The model list is too large.", res.status, "too-large");
		}
		chunks.push(value);
	}
	const buf = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		buf.set(c, at);
		at += c.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(buf));
	} catch {
		throw new GatewayFetchError("The gateway's answer was not JSON.", res.status, "network");
	}
}
