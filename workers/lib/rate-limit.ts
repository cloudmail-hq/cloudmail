// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Request-rate limiting.
 *
 * ## What was missing
 *
 * The only limit in the app was on *outbound mail*: a mailbox may send 20
 * messages an hour and 100 a day, counted exactly by the Durable Object that
 * owns it. Nothing bounded requests. A signed-in caller — or anything holding a
 * service token — could hammer search, the cross-mailbox person fan-out (which
 * makes one Durable Object call per mailbox), or the MCP endpoint, whose tools
 * reach Workers AI and the send path.
 *
 * ## Keyed per caller, not per IP
 *
 * The whole app sits behind Cloudflare Access, so requests arrive already
 * attributed to a person or a service token. Keying on that is both fairer and
 * harder to evade than keying on IP: a team behind one office NAT shares an
 * address, and an attacker with a credential can change address freely. IP is
 * only the fallback for a request we could not attribute, which behind Access
 * should not happen.
 *
 * ## What this does and does not cover
 *
 * Cloudflare's rate limit binding allows a 10- or 60-second window, so this is
 * burst protection — it stops a runaway loop or a scripted scrape, and it is not
 * a monthly budget. The long-window controls stay where they already were: the
 * per-mailbox send quota in `durableObject/rate-limit.ts`, which is exact.
 *
 * It also does not bound work done *over an established WebSocket*. `/agents/*`
 * upgrades to a socket and the model is then invoked per message, none of which
 * is an HTTP request this middleware sees. Limiting the handshake, which is what
 * happens here, bounds how often a client may (re)connect and nothing more.
 * Metering AI invocations belongs inside the agent, where the cost is incurred.
 *
 * ## Failure mode
 *
 * The bindings are treated as optional. A deployment whose account or config
 * lacks them logs once and runs unlimited rather than refusing every request —
 * failing open is right here, because the alternative is a rate limiter that can
 * take the whole mailbox offline through misconfiguration, and the boundary that
 * actually protects the data is Access plus authorization, not this.
 */

import { createMiddleware } from "hono/factory";
import type { MailboxContext } from "./mailbox";

/**
 * Minimal shape of Cloudflare's rate limit binding.
 *
 * Declared structurally rather than imported so this module can be unit tested
 * with a plain object, and so a deployment without the binding still typechecks.
 */
export interface RateLimiterBinding {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Which bucket a request is counted against. */
export type RateLimitBucket = "api" | "mcp";

/**
 * The identity a request is charged to.
 *
 * Prefixed by kind so a person and a service token that somehow shared an
 * identifier could not spend each other's budget, and so an IP fallback can
 * never collide with a real principal.
 */
export function rateLimitKey(options: {
	bucket: RateLimitBucket;
	principalKind?: "user" | "service" | null;
	principalId?: string | null;
	ip?: string | null;
}): string {
	const { bucket } = options;

	if (options.principalId) {
		const kind = options.principalKind ?? "user";
		return `${bucket}:${kind}:${options.principalId}`;
	}

	// Unattributed. Behind Access this should not occur, so it is worth keeping
	// distinguishable in the key rather than lumping every such request together
	// under one bucket that one caller could exhaust for everyone.
	if (options.ip) return `${bucket}:ip:${options.ip}`;

	return `${bucket}:anonymous`;
}

/** Logged once per isolate, so a missing binding is visible but not noisy. */
const warned = new Set<string>();

function warnOnce(binding: string): void {
	if (warned.has(binding)) return;
	warned.add(binding);
	console.warn(
		`${binding} is not bound, so request rate limiting is disabled. Add a ` +
			`"ratelimits" entry to wrangler.jsonc to enable it.`,
	);
}

/**
 * Refuse a caller who is making requests too quickly.
 *
 * `Retry-After` is the window length: the binding reports only success or
 * failure, not when the budget refills, and a fixed hint the client can act on
 * beats no hint at all.
 */
export function rateLimitGuard(options: {
	bucket: RateLimitBucket;
	bindingName: string;
	/** Reads the binding off env, so an absent one is a runtime skip. */
	select: (env: MailboxContext["Bindings"]) => RateLimiterBinding | undefined;
	/** Seconds to advertise in `Retry-After`; matches the configured period. */
	retryAfterSeconds: number;
}) {
	return createMiddleware<MailboxContext>(async (c, next) => {
		const limiter = options.select(c.env);
		if (!limiter) {
			warnOnce(options.bindingName);
			return next();
		}

		const identity = c.var.principal?.identity ?? null;
		const key = rateLimitKey({
			bucket: options.bucket,
			principalKind: identity?.kind ?? null,
			principalId: identity?.id ?? null,
			ip: c.req.header("cf-connecting-ip") ?? null,
		});

		let allowed = true;
		try {
			const outcome = await limiter.limit({ key });
			allowed = outcome.success;
		} catch (e) {
			// A limiter that errors must not take the app down with it.
			console.error(
				`${options.bindingName} failed, allowing the request:`,
				(e as Error).message,
			);
		}

		if (!allowed) {
			return c.json({ error: "Too many requests. Slow down and retry." }, 429, {
				"Retry-After": String(options.retryAfterSeconds),
			});
		}

		return next();
	});
}
