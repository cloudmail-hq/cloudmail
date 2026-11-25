/** Errors thrown by the client. Every HTTP failure is a `TapetideError`. */

export interface ErrorInit {
	status: number;
	code?: string;
	body?: unknown;
	headers?: Headers;
	cause?: unknown;
}

export class TapetideError extends Error {
	/** HTTP status, or 0 when no response arrived. */
	readonly status: number;
	/** Machine-readable `code` from the error body, when the server sent one. */
	readonly code: string | undefined;
	/** The parsed response body (JSON when possible, else text). */
	readonly body: unknown;
	readonly headers: Headers | undefined;

	constructor(message: string, init: ErrorInit) {
		super(message, init.cause === undefined ? undefined : { cause: init.cause });
		this.name = "TapetideError";
		this.status = init.status;
		this.code = init.code;
		this.body = init.body;
		this.headers = init.headers;
	}
}

/** 401: no credentials, or the token is invalid, expired or revoked. */
export class AuthenticationError extends TapetideError {
	override name = "AuthenticationError";
}
/** 403: authenticated, but the grant or token scope does not allow it (`insufficient_scope`, `session_required`, ...). */
export class PermissionDeniedError extends TapetideError {
	override name = "PermissionDeniedError";
}
export class NotFoundError extends TapetideError {
	override name = "NotFoundError";
}
/** 409, including `idempotency_key_reused`. */
export class ConflictError extends TapetideError {
	override name = "ConflictError";
}
/**
 * 409 from `approvals.approve` when the held send changed after you read it
 * (the requester revised it, or someone edited it). Nothing was sent.
 * `approval` is the current version: review it, then approve again with
 * `{ revision: approval.revision }`.
 */
export class ApprovalChangedError extends ConflictError {
	override name = "ApprovalChangedError";
	/** The approval as it is now (from the 409 body). */
	get approval(): ({ revision?: number; status?: string } & Record<string, unknown>) | undefined {
		const b = this.body as { approval?: { revision?: number; status?: string } & Record<string, unknown> } | undefined;
		return b?.approval;
	}
}
/** 400 or 422: the request was refused as invalid. */
export class ValidationError extends TapetideError {
	override name = "ValidationError";
}
/** 429: rate limited or over a send cap. */
export class RateLimitError extends TapetideError {
	override name = "RateLimitError";
	/** The server's `Retry-After` hint in seconds, or null when it sent none. */
	readonly retryAfter: number | null;

	constructor(message: string, init: ErrorInit) {
		super(message, init);
		this.retryAfter = retryAfterSeconds(init.headers?.get("Retry-After") ?? null);
	}
}
/** 5xx. On a send this can mean the message went out, so the client does not retry it. */
export class ServerError extends TapetideError {
	override name = "ServerError";
}
/** No response: DNS, TCP, TLS, timeout or abort. */
export class APIConnectionError extends TapetideError {
	override name = "APIConnectionError";
}

/** Seconds from a `Retry-After` header (delta-seconds or an HTTP date). */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds);
	const at = Date.parse(header);
	return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

export function errorFor(status: number, body: unknown, headers?: Headers): TapetideError {
	const obj = body && typeof body === "object" ? (body as { error?: unknown; message?: unknown; code?: unknown }) : null;
	const message =
		typeof obj?.error === "string" && obj.error
			? obj.error
			: typeof obj?.message === "string" && obj.message
				? obj.message
				: typeof body === "string" && body
					? body.slice(0, 300)
					: `HTTP ${status}`;
	const init: ErrorInit = { status, code: typeof obj?.code === "string" ? obj.code : undefined, body, headers };
	switch (true) {
		case status === 401:
			return new AuthenticationError(message, init);
		case status === 403:
			return new PermissionDeniedError(message, init);
		case status === 404:
			return new NotFoundError(message, init);
		case status === 409:
			return new ConflictError(message, init);
		case status === 400 || status === 422:
			return new ValidationError(message, init);
		case status === 429:
			return new RateLimitError(message, init);
		case status >= 500:
			return new ServerError(message, init);
		default:
			return new TapetideError(message, init);
	}
}
