/**
 * `Server-Timing` for the API, so per-request cost is visible in the browser's
 * network panel (and to anyone profiling with `curl -v`) without logs.
 *
 * Metrics are durations in milliseconds. In Workers `performance.now()` only
 * advances across I/O, which is exactly what these spans measure: AuthDO,
 * R2 and Durable Object round trips.
 *
 * Only `/api/*` responses carry the header. The names are coarse stage labels
 * (`auth`, `mailbox`, `handler`), nothing that identifies a user or a row.
 */

import type { Context, MiddlewareHandler, Next } from "hono";

type TimingContext = Context<{ Variables: { serverTiming?: string[] } }>;

function now(): number {
	try {
		return performance.now();
	} catch {
		return Date.now();
	}
}

/**
 * Record a finished span. A no-op outside a timed request. `desc` is a fixed
 * label such as `cache=hit`; anything outside `[\w=|.-]` is dropped rather
 * than escaped, so nothing request-derived can reach the header.
 */
export function recordTiming(c: Context, name: string, ms: number, desc?: string): void {
	const list = (c as TimingContext).get("serverTiming");
	if (!list) return;
	const label = desc && /^[\w=|.-]+$/.test(desc) ? `;desc="${desc}"` : "";
	list.push(`${name};dur=${ms.toFixed(1)}${label}`);
}

/** Time `work` as `name`. */
export async function timed<T>(c: Context, name: string, work: () => Promise<T>): Promise<T> {
	const start = now();
	try {
		return await work();
	} finally {
		recordTiming(c, name, now() - start);
	}
}

/**
 * Measure a middleware's own cost: the time until it calls `next()` (or
 * returns, if it short-circuits), excluding everything downstream.
 */
export function timedMiddleware<M extends MiddlewareHandler>(
	name: string,
	middleware: M,
	/** A label read from the context once the middleware is done (e.g. `cache=hit`). */
	describe?: (c: Context) => string | undefined,
): M {
	const wrapped: MiddlewareHandler = async (c, next) => {
		const start = now();
		let recorded = false;
		const mark = () => {
			if (!recorded) {
				recorded = true;
				recordTiming(c, name, now() - start, describe?.(c));
			}
		};
		try {
			return await middleware(c, async () => {
				mark();
				await next();
			});
		} finally {
			mark();
		}
	};
	return wrapped as M;
}

/**
 * Collect spans for `/api/*` and write them, plus `total`, on the way out.
 * Mount first so `total` covers the whole request.
 */
export const serverTiming: MiddlewareHandler = async (c, next: Next) => {
	const path = new URL(c.req.url).pathname;
	if (!path.startsWith("/api/")) return next();
	const list: string[] = [];
	(c as TimingContext).set("serverTiming", list);
	const start = now();
	try {
		await next();
	} finally {
		if (c.res) {
			list.push(`total;dur=${(now() - start).toFixed(1)}`);
			try {
				c.res.headers.append("Server-Timing", list.join(", "));
			} catch {
				// Immutable headers (a passthrough fetch response): skip quietly.
			}
		}
	}
};
