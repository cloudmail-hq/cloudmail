/**
 * The transport: one `request()` used by every resource.
 *
 * - Bearer auth, JSON in and out.
 * - Idempotency: a POST to a route the server keys (sends and creates) gets an
 *   `Idempotency-Key` automatically, generated once per call, so every retry of
 *   that call carries the same key and the server runs it at most once.
 * - Retries: 5xx, 408, 429, transport errors and 409
 *   `idempotency_request_in_progress`, with exponential backoff and jitter
 *   (honouring `Retry-After`). Only for requests that are safe to repeat: GETs,
 *   and POSTs that carry an idempotency key. Anything else fails on the first
 *   error, because repeating it could do the work twice.
 * - Sends (`SEND_POST_PATHS`) are not retried on a 5xx or 408. The server does
 *   not keep a 5xx against the key, so a retry runs the send again, and a 5xx
 *   that came after the provider accepted the message would send it twice.
 *   The exception is a 503 the server returns before running anything
 *   (`idempotency_unavailable`, `licence_unavailable`).
 */

import { APIConnectionError, TapetideError, errorFor } from "./errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
	/** Deployment origin, e.g. `https://mail.example.com`. */
	baseUrl: string;
	/** API token, `ttk_<id>_<secret>`. */
	token: string;
	/** Retries after the first attempt (default 2). */
	maxRetries?: number;
	/** Per-attempt timeout in ms (default 30 000). */
	timeoutMs?: number;
	/** Custom fetch (tests, proxies). Defaults to the global `fetch`. */
	fetch?: FetchLike;
	/** Extra headers on every request. */
	headers?: Record<string, string>;
	/** Backoff base in ms (default 500). */
	retryBaseMs?: number;
	/** Injectable sleep, for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable key generator, for tests. Defaults to `crypto.randomUUID()`. */
	idempotencyKey?: () => string;
}

export interface RequestOptions {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Path with `{param}` placeholders, as in the OpenAPI document. */
	path: string;
	params?: Record<string, string>;
	query?: Record<string, QueryValue>;
	body?: unknown;
	/** A non-JSON body (raw bytes), sent as `contentType` (default `application/octet-stream`). */
	rawBody?: Uint8Array | ArrayBuffer | Blob;
	contentType?: string;
	/**
	 * Hand back the unread `Response` as `data` (binary downloads: attachments,
	 * mbox exports). Error responses still throw a `TapetideError`.
	 */
	raw?: boolean;
	/** Explicit key; `false` turns the automatic key off for this call. */
	idempotencyKey?: string | false;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/**
	 * Retry 5xx and 408 responses. Default: true, except POSTs to
	 * `SEND_POST_PATHS`, where such a response may mean the mail went out.
	 */
	retryServerErrors?: boolean;
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

export interface ApiResponse<T> {
	status: number;
	data: T;
	headers: Headers;
	/** True when the server replayed a stored response for this idempotency key. */
	replayed: boolean;
	/** The key sent, if any. */
	idempotencyKey: string | undefined;
}

/**
 * POST routes that honour `Idempotency-Key` (`workers/lib/idempotency-routes.ts`).
 * Paths use OpenAPI `{param}` placeholders.
 */
export const IDEMPOTENT_POST_PATHS: ReadonlySet<string> = new Set([
	"/api/v1/mailboxes/{mailboxId}/emails",
	"/api/v1/mailboxes/{mailboxId}/emails/{id}/reply",
	"/api/v1/mailboxes/{mailboxId}/emails/{id}/forward",
	"/api/v1/mailboxes/{mailboxId}/drafts",
	"/api/v1/mailboxes/{mailboxId}/scheduled-sends",
	"/api/v1/mailboxes/{mailboxId}/scheduled-sends/{emailId}/send-now",
	"/api/v1/mailboxes/{mailboxId}/template-sends",
	"/api/v1/mailboxes/{mailboxId}/emails/{id}/followup",
	"/api/v1/mailboxes/{mailboxId}/emails/{id}/followup/cancel",
	"/api/v1/mailboxes/{mailboxId}/screener/{sender}",
	"/api/v1/mailboxes/{mailboxId}/approvals/{id}/approve",
	"/api/v1/mailboxes/{mailboxId}/imports",
	"/api/v1/mailboxes",
	"/api/v1/webhooks",
	"/api/v1/domains",
	"/api/v1/suppressions",
	"/api/v1/sequences/{id}/enroll",
	"/api/v1/agent-inboxes",
	"/api/v1/ai/providers",
]);

/**
 * POST routes that send or queue mail. A 5xx or 408 from one of these is not
 * retried: it may have been sent, and the server does not keep a 5xx against
 * the idempotency key, so a retry would run the send again.
 */
export const SEND_POST_PATHS: ReadonlySet<string> = new Set([
	"/api/v1/mailboxes/{mailboxId}/emails",
	"/api/v1/mailboxes/{mailboxId}/emails/{id}/reply",
	"/api/v1/mailboxes/{mailboxId}/emails/{id}/forward",
	"/api/v1/mailboxes/{mailboxId}/scheduled-sends",
	"/api/v1/mailboxes/{mailboxId}/scheduled-sends/{emailId}/send-now",
	"/api/v1/mailboxes/{mailboxId}/template-sends",
	"/api/v1/mailboxes/{mailboxId}/approvals/{id}/approve",
	"/api/v1/sequences/{id}/enroll",
]);

/** 503 codes the server answers before running the handler; safe to retry anywhere. */
const REFUSED_BEFORE_RUNNING = new Set(["idempotency_unavailable", "licence_unavailable"]);

export const SDK_VERSION = "0.2.0";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;

function defaultKey(): string {
	const c = globalThis.crypto as Crypto | undefined;
	if (c?.randomUUID) return c.randomUUID();
	// Fallback: 128 random bits as hex.
	const bytes = new Uint8Array(16);
	c!.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildPath(template: string, params: Record<string, string> = {}): string {
	return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
		const value = params[name];
		if (value === undefined || value === "") throw new TypeError(`Missing path parameter "${name}" for ${template}`);
		return encodeURIComponent(value);
	});
}

export function buildQuery(query: Record<string, QueryValue> = {}): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
		else params.set(key, String(value));
	}
	const s = params.toString();
	return s ? `?${s}` : "";
}

/** Milliseconds from a `Retry-After` header (seconds or HTTP date), capped. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_AFTER_MS);
	const at = Date.parse(header);
	return Number.isFinite(at) ? Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS) : null;
}

async function readBody(res: Response): Promise<unknown> {
	if (res.status === 204) return undefined;
	const text = await res.text();
	if (!text) return undefined;
	const type = res.headers.get("content-type") ?? "";
	if (type.includes("json") || /^[\[{]/.test(text.trimStart())) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

export class HttpClient {
	readonly baseUrl: string;
	private readonly token: string;
	private readonly maxRetries: number;
	private readonly timeoutMs: number;
	private readonly fetchImpl: FetchLike;
	private readonly extraHeaders: Record<string, string>;
	private readonly retryBaseMs: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly newKey: () => string;

	constructor(options: ClientOptions) {
		if (!options.baseUrl) throw new TypeError("baseUrl is required");
		if (!options.token) throw new TypeError("token is required");
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.token = options.token;
		this.maxRetries = Math.max(0, options.maxRetries ?? 2);
		this.timeoutMs = options.timeoutMs ?? 30_000;
		const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
		if (!f) throw new TypeError("No fetch implementation available; pass options.fetch");
		this.fetchImpl = (input, init) => f(input, init);
		this.extraHeaders = options.headers ?? {};
		this.retryBaseMs = options.retryBaseMs ?? 500;
		this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.newKey = options.idempotencyKey ?? defaultKey;
	}

	/** Headers every request carries (auth, user agent). */
	authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
			"User-Agent": `cloudmail-typescript/${SDK_VERSION}`,
			...this.extraHeaders,
		};
	}

	url(path: string, params?: Record<string, string>, query?: Record<string, QueryValue>): string {
		return `${this.baseUrl}${buildPath(path, params)}${buildQuery(query)}`;
	}

	/** Raw fetch with auth headers, no retries (used by the event stream). */
	rawFetch(url: string, init: RequestInit): Promise<Response> {
		return this.fetchImpl(url, { ...init, headers: { ...this.authHeaders(), ...(init.headers as Record<string, string> | undefined) } });
	}

	backoffMs(attempt: number): number {
		const exp = this.retryBaseMs * 2 ** attempt;
		return Math.round(exp / 2 + Math.random() * (exp / 2));
	}

	async request<T>(opts: RequestOptions): Promise<ApiResponse<T>> {
		const key =
			opts.idempotencyKey === false
				? undefined
				: (opts.idempotencyKey ?? (opts.method === "POST" && IDEMPOTENT_POST_PATHS.has(opts.path) ? this.newKey() : undefined));
		const retryable = opts.method === "GET" || key !== undefined;
		const url = this.url(opts.path, opts.params, opts.query);
		const headers: Record<string, string> = { Accept: opts.raw ? "*/*" : "application/json", ...this.authHeaders(), ...opts.headers };
		if (opts.rawBody !== undefined) headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
		else if (opts.body !== undefined) headers["Content-Type"] = "application/json";
		if (key !== undefined) headers["Idempotency-Key"] = key;
		const body: BodyInit | undefined =
			opts.rawBody !== undefined ? (opts.rawBody as BodyInit) : opts.body === undefined ? undefined : JSON.stringify(opts.body);
		const retryServerErrors = opts.retryServerErrors ?? !(opts.method === "POST" && SEND_POST_PATHS.has(opts.path));

		for (let attempt = 0; ; attempt++) {
			const canRetry = retryable && attempt < this.maxRetries;
			const timeout = AbortSignal.timeout(this.timeoutMs);
			const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
			let res: Response;
			try {
				res = await this.fetchImpl(url, { method: opts.method, headers, body, signal });
			} catch (cause) {
				if (opts.signal?.aborted) throw cause;
				if (canRetry) {
					await this.sleep(this.backoffMs(attempt));
					continue;
				}
				throw new APIConnectionError(`Request to ${opts.method} ${opts.path} failed: ${(cause as Error)?.message ?? cause}`, {
					status: 0,
					cause,
				});
			}

			if (res.ok && opts.raw) {
				return {
					status: res.status,
					data: res as T,
					headers: res.headers,
					replayed: res.headers.get("Idempotent-Replayed") === "true",
					idempotencyKey: key,
				};
			}
			const data = await readBody(res);
			if (res.ok) {
				return {
					status: res.status,
					data: data as T,
					headers: res.headers,
					replayed: res.headers.get("Idempotent-Replayed") === "true",
					idempotencyKey: key,
				};
			}
			const err = errorFor(res.status, data, res.headers);
			const inProgress = res.status === 409 && err.code === "idempotency_request_in_progress";
			const refusedBeforeRunning = res.status === 503 && err.code !== undefined && REFUSED_BEFORE_RUNNING.has(err.code);
			const mayHaveRun = res.status >= 500 || res.status === 408;
			const statusRetryable = RETRYABLE_STATUS.has(res.status) && (!mayHaveRun || retryServerErrors || refusedBeforeRunning);
			if (canRetry && (statusRetryable || inProgress)) {
				await this.sleep(retryAfterMs(res.headers.get("Retry-After")) ?? this.backoffMs(attempt));
				continue;
			}
			throw err;
		}
	}
}

export { TapetideError };
