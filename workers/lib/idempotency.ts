// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Idempotency keys for sends and creates.
 *
 * Agents retry. A send that timed out on the way back has usually already gone,
 * and sending it again is the worst thing an agent mailbox can do to a
 * customer. A caller that sends `Idempotency-Key: <key>` (REST) or
 * `idempotency_key` (MCP) gets these guarantees, which match Resend's:
 *
 * - Keys are scoped per principal (user id + API token id) and per route, so two
 *   tokens, or two routes, never collide.
 * - The first request with a key runs. Its status and body are kept for 24 h.
 * - A repeat with the same payload gets the stored response back, with
 *   `Idempotent-Replayed: true`. Nothing runs again.
 * - The same key with a different payload is refused: 409
 *   `idempotency_key_reused`.
 * - A duplicate that arrives while the first is still running is refused: 409
 *   `idempotency_request_in_progress` with `Retry-After: 1`.
 * - A 5xx is not stored, so a retry can succeed. 4xx responses are stored,
 *   except 408 and 429, which say "come back later" rather than "this request
 *   is wrong".
 *
 * Storage is the Durable Object that owns the operation: the mailbox's
 * `MailboxDO` for mailbox routes and MCP tools, the global `AuthDO` for
 * instance routes. See ./idempotency-store.ts for why the check-and-set has to
 * happen inside the object.
 */

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../types";
import type { MailboxContext } from "./mailbox";
import type { Principal } from "./authz";
import type {
	IdempotencyBeginInput,
	IdempotencyBeginResult,
	IdempotencyCompleteInput,
	IdempotencyReleaseInput,
} from "./idempotency-store";
import { INSTANCE_IDEMPOTENT_PATHS, MAILBOX_IDEMPOTENT_PATHS } from "./idempotency-routes";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export const IDEMPOTENCY_ERROR = {
	reused: "idempotency_key_reused",
	inProgress: "idempotency_request_in_progress",
	invalid: "invalid_idempotency_key",
	unavailable: "idempotency_unavailable",
} as const;

/**
 * Largest response body kept for replay. Every keyed route answers with a small
 * JSON object; anything bigger is released rather than stored, because a
 * Durable Object SQLite row is capped at 2 MB.
 */
const MAX_STORED_BODY = 512 * 1024;

/** The RPC surface both `MailboxDO` and `AuthDO` expose. */
export interface IdempotencyBackend {
	idempotencyBegin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult>;
	idempotencyComplete(input: IdempotencyCompleteInput): Promise<boolean>;
	idempotencyRelease(input: IdempotencyReleaseInput): Promise<void>;
}

// ── Pure helpers ────────────────────────────────────────────────────

/** 1–256 printable ASCII characters (0x20–0x7E). */
export function isValidIdempotencyKey(key: string): boolean {
	return key.length >= 1 && key.length <= IDEMPOTENCY_KEY_MAX_LENGTH && /^[\x20-\x7e]+$/.test(key);
}

/**
 * JSON with object keys sorted at every depth, so `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` hash the same. Arrays keep their order: it is meaningful.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Canonical form of a raw request body: canonical JSON when it parses, else the text. */
export function canonicalBody(raw: string): string {
	if (raw.trim() === "") return "";
	try {
		return canonicalJson(JSON.parse(raw));
	} catch {
		return raw;
	}
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Who a key belongs to: the user (by stable id where there is one) plus the API
 * token, so two tokens of one user never share keys. Sessions and OAuth have no
 * token id and share the user's "-" slot.
 */
export function principalKey(input: { userId: string; tokenId?: string | null }): string {
	return `u:${input.userId}|t:${input.tokenId || "-"}`;
}

/**
 * The key owner for a resolved principal, or null when the caller has no
 * identity to scope by. A null owner means keys are not honoured at all: one
 * shared "anonymous" slot would let unrelated callers (an unenforced Access
 * deployment, say) replay or block each other's requests.
 */
export function principalKeyOf(principal: Principal | undefined): string | null {
	const identity = principal?.identity;
	const userId = identity
		? `${identity.kind}:${identity.subject || identity.id}`
		: principal?.developmentBypass
			? "dev"
			: null;
	if (!userId) return null;
	return principalKey({ userId, tokenId: principal?.token?.id ?? null });
}

/**
 * Whether a response is kept for replay: 2xx and 4xx, minus the 4xx that are
 * about the caller's situation rather than the request. 401/403 can change
 * the moment a grant is added, and 408/429 say "come back later"; pinning any
 * of them to the key for a day would block the retry that should now succeed.
 */
export function isStorableStatus(status: number): boolean {
	if (status >= 500) return false;
	if (status === 401 || status === 403 || status === 408 || status === 429) return false;
	return status >= 200;
}

function conflict(code: string, message: string, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ error: message, code }), {
		status: 409,
		headers: { "Content-Type": "application/json", ...extraHeaders },
	});
}

export function reusedResponse(): Response {
	return conflict(
		IDEMPOTENCY_ERROR.reused,
		"This Idempotency-Key was already used with a different request. Use a new key for a new request.",
	);
}

export function inProgressResponse(): Response {
	return conflict(
		IDEMPOTENCY_ERROR.inProgress,
		"A request with this Idempotency-Key is still being processed. Retry shortly.",
		{ "Retry-After": "1" },
	);
}

// ── Hono middleware ─────────────────────────────────────────────────

export interface IdempotencyRouteOptions {
	/**
	 * Route label the key is scoped to, e.g. `POST /api/v1/mailboxes/:mailboxId/emails`.
	 * The concrete path is part of the payload hash, so reusing a key on another
	 * message or mailbox is a payload mismatch rather than a replay.
	 */
	route: string;
	/** Where keys live for this route. */
	backend: (c: Context<MailboxContext>) => IdempotencyBackend;
	/** Who the caller is. Defaults to the resolved `principal`. */
	principal?: (c: Context<MailboxContext>) => string | null;
	/**
	 * Rewrite the response body before it is stored, for responses that carry a
	 * secret which must not be kept at rest. The live response is unchanged.
	 */
	redact?: (body: string) => string;
}

/** The mailbox's own Durable Object (set by `requireMailbox`). */
export const mailboxBackend = (c: Context<MailboxContext>): IdempotencyBackend =>
	c.var.mailboxStub as unknown as IdempotencyBackend;

/**
 * The global AuthDO, for instance-level operations. Resolved by name rather
 * than through `authStore()`, whose module imports `cloudflare:workers`.
 */
export const instanceBackend = (c: Context<MailboxContext>): IdempotencyBackend => {
	const ns = c.env.AUTH_STORE as unknown as DurableObjectNamespace;
	return ns.get(ns.idFromName("global")) as unknown as IdempotencyBackend;
};

/**
 * Honour `Idempotency-Key` on one route. A request without the header passes
 * through untouched, so this changes nothing for callers that do not opt in.
 */
export function idempotency(options: IdempotencyRouteOptions) {
	return createMiddleware<MailboxContext>(async (c, next) => {
		if (c.req.method !== "POST") return next();
		const key = c.req.header(IDEMPOTENCY_HEADER);
		if (key === undefined) return next();
		if (!isValidIdempotencyKey(key)) {
			return c.json(
				{
					error: `Idempotency-Key must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters.`,
					code: IDEMPOTENCY_ERROR.invalid,
				},
				400,
			);
		}
		const who = options.principal ? options.principal(c) : principalKeyOf(c.var.principal);
		// No identity to scope by: do not key. See principalKeyOf.
		if (!who) return next();

		// Hono caches the body, so the handler's own `c.req.json()` still works.
		const raw = await c.req.text();
		const url = new URL(c.req.url);
		const requestHash = await sha256Hex(`POST ${url.pathname}${url.search}\n${canonicalBody(raw)}`);
		const scope = `${who}|${options.route}`;
		const ref = { scope, key, requestHash };

		let backend: IdempotencyBackend;
		let begun: IdempotencyBeginResult;
		try {
			backend = options.backend(c);
			begun = await backend.idempotencyBegin(ref);
		} catch (e) {
			console.error("idempotency: begin failed:", (e as Error).message);
			// Proceeding without the guarantee could send twice; ask for a retry.
			return c.json(
				{ error: "Idempotency storage is unavailable. Retry shortly.", code: IDEMPOTENCY_ERROR.unavailable },
				503,
				{ "Retry-After": "1" },
			);
		}

		if (begun.state === "mismatch") return reusedResponse();
		if (begun.state === "in_progress") return inProgressResponse();
		if (begun.state === "replay") {
			const headers = new Headers({ [IDEMPOTENT_REPLAYED_HEADER]: "true" });
			if (begun.contentType) headers.set("Content-Type", begun.contentType);
			return new Response(begun.body === "" ? null : begun.body, { status: begun.status, headers });
		}

		const held = { ...ref, reservedAt: begun.reservedAt };
		const release = () =>
			backend.idempotencyRelease(held).catch((e) => {
				console.error("idempotency: release failed:", (e as Error).message);
			});

		try {
			await next();
		} catch (e) {
			await release();
			throw e;
		}

		const res = c.res;
		// Hono's error handler leaves a 500 in `c.res` rather than throwing.
		if (!res || !isStorableStatus(res.status)) {
			await release();
			return;
		}
		let body: string;
		try {
			body = await res.clone().text();
		} catch {
			await release();
			return;
		}
		if (options.redact) body = options.redact(body);
		if (body.length > MAX_STORED_BODY) {
			await release();
			return;
		}
		try {
			await backend.idempotencyComplete({
				...held,
				status: res.status,
				body,
				contentType: res.headers.get("Content-Type"),
			});
		} catch (e) {
			// The request already ran; failing it now would invite the retry this
			// exists to make safe. The reservation times out on its own.
			console.error("idempotency: complete failed:", (e as Error).message);
		}
	});
}

/**
 * Mount `idempotency` on each route. Each entry is `[path, backend]`; the route
 * label is `POST <path>`.
 */
export function mountIdempotency(
	app: { on: (method: string[], path: string, ...handlers: any[]) => unknown },
	routes: ReadonlyArray<readonly [string, (c: Context<MailboxContext>) => IdempotencyBackend]>,
): void {
	for (const [path, backend] of routes) {
		app.on(
			["POST"],
			path,
			idempotency({ route: `POST ${path}`, backend, redact: REDACTED_ROUTES.get(path) }),
		);
	}
}

/** Creates whose response carries a one-time secret, and how to strip it. */
const REDACTED_ROUTES: ReadonlyMap<string, (body: string) => string> = new Map([
	["/api/v1/webhooks", redactSecret],
	// Two secrets, nested: the agent's `ttk_` token and its webhook secret.
	["/api/v1/agent-inboxes", redactNestedSecrets],
]);

/** Per-mailbox routes. Mounted after the capability gates. */
export const MAILBOX_IDEMPOTENT_ROUTES = MAILBOX_IDEMPOTENT_PATHS.map((p) => [p, mailboxBackend] as const);

/** Instance-level routes. Keys live in the AuthDO. */
export const INSTANCE_IDEMPOTENT_ROUTES = INSTANCE_IDEMPOTENT_PATHS.map((p) => [p, instanceBackend] as const);

/**
 * Drop a plaintext top-level `secret` from a stored create response (API token,
 * webhook signing secret).
 *
 * A secret is shown once. AuthDO keeps only a hash of every token secret, and a
 * replay store holding the plaintext for a day would undo that. A replay
 * therefore returns the same record with `secret: null` and
 * `secret_redacted: true`: the thing was created once, and a caller that lost
 * the secret rotates it (webhooks) or revokes and recreates (tokens).
 */
export function redactSecret(body: string): string {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		if (parsed && typeof parsed === "object" && "secret" in parsed) {
			return JSON.stringify({ ...parsed, secret: null, secret_redacted: true });
		}
		return body;
	} catch {
		return body;
	}
}

/**
 * Drop every `secret` field at any depth (agent inbox create returns the token
 * and the webhook secret inside nested objects). Same `secret_redacted: true`
 * marker at the top level as {@link redactSecret}.
 */
export function redactNestedSecrets(body: string): string {
	let found = false;
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip);
		if (!value || typeof value !== "object") return value;
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (k === "secret" && typeof v === "string") {
				found = true;
				out[k] = null;
			} else {
				out[k] = strip(v);
			}
		}
		return out;
	};
	try {
		const parsed = JSON.parse(body) as unknown;
		const stripped = strip(parsed);
		if (!found || !stripped || typeof stripped !== "object" || Array.isArray(stripped)) return body;
		return JSON.stringify({ ...(stripped as Record<string, unknown>), secret_redacted: true });
	} catch {
		return body;
	}
}

/** Token creation lives under `/api/auth`, before `resolvePrincipal` runs. */
export const tokenCreateIdempotency = idempotency({
	route: "POST /api/auth/tokens",
	backend: instanceBackend,
	redact: redactSecret,
	principal: (c) =>
		c.var.authUser
			? principalKey({ userId: `user:${c.var.authUser.id}`, tokenId: c.var.authToken?.id ?? null })
			: null,
});

// ── MCP tools ───────────────────────────────────────────────────────

/** Description for the optional `idempotency_key` argument on MCP tools. */
export const MCP_IDEMPOTENCY_KEY_DESCRIPTION =
	"Optional. A unique key (1-256 printable ASCII) for this action. Retrying with the same key and the same arguments within 24 h returns the first result instead of acting twice. Reusing it with different arguments is refused.";

export interface McpToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
}

function mcpRefusal(code: string, message: string): McpToolResult {
	return { content: [{ type: "text", text: JSON.stringify({ error: message, code }) }], isError: true };
}

/**
 * Run an MCP tool at most once per key.
 *
 * Only a successful result is stored. A tool error here covers transient
 * failures (the provider refused, the quota was hit) as well as bad input, and
 * the result carries no status that would tell them apart, so an error is
 * released and a retry with the same key runs again.
 */
export async function runIdempotentTool(
	opts: {
		backend: IdempotencyBackend;
		principal: Principal;
		tool: string;
		key: string | undefined;
		args: Record<string, unknown>;
	},
	run: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
	if (opts.key === undefined) return run();
	if (!isValidIdempotencyKey(opts.key)) {
		return mcpRefusal(
			IDEMPOTENCY_ERROR.invalid,
			`idempotency_key must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters.`,
		);
	}
	const owner = principalKeyOf(opts.principal);
	// No identity to scope by: run unkeyed rather than share a slot (see principalKeyOf).
	if (!owner) return run();
	const { idempotency_key: _omit, ...payload } = opts.args;
	const requestHash = await sha256Hex(`mcp ${opts.tool}\n${canonicalJson(payload)}`);
	const ref = { scope: `${owner}|mcp:${opts.tool}`, key: opts.key, requestHash };

	let begun: IdempotencyBeginResult;
	try {
		begun = await opts.backend.idempotencyBegin(ref);
	} catch (e) {
		console.error("idempotency: begin failed:", (e as Error).message);
		return mcpRefusal(IDEMPOTENCY_ERROR.unavailable, "Idempotency storage is unavailable. Retry shortly.");
	}
	if (begun.state === "mismatch") {
		return mcpRefusal(
			IDEMPOTENCY_ERROR.reused,
			"This idempotency_key was already used with different arguments. Use a new key for a new action.",
		);
	}
	if (begun.state === "in_progress") {
		return mcpRefusal(
			IDEMPOTENCY_ERROR.inProgress,
			"An action with this idempotency_key is still running. Retry in a second.",
		);
	}
	if (begun.state === "replay") {
		try {
			const stored = JSON.parse(begun.body) as McpToolResult;
			return { ...stored, content: [...stored.content, { type: "text", text: JSON.stringify({ idempotent_replayed: true }) }] };
		} catch {
			return mcpRefusal(IDEMPOTENCY_ERROR.unavailable, "The stored result could not be read.");
		}
	}

	const held = { ...ref, reservedAt: begun.reservedAt };
	let result: McpToolResult;
	try {
		result = await run();
	} catch (e) {
		await opts.backend.idempotencyRelease(held).catch(() => {});
		throw e;
	}
	if (result.isError) {
		await opts.backend.idempotencyRelease(held).catch(() => {});
		return result;
	}
	await opts.backend
		.idempotencyComplete({ ...held, status: 200, body: JSON.stringify(result), contentType: "application/json" })
		.catch((e) => console.error("idempotency: complete failed:", (e as Error).message));
	return result;
}

/** The mailbox's Durable Object, for MCP tools. */
export function mailboxIdempotencyBackend(env: Env, mailboxId: string): IdempotencyBackend {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as IdempotencyBackend;
}
