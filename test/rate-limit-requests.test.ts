// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Request-rate limiting.
 *
 * The app limited outbound mail — 20 an hour, 100 a day, counted exactly per
 * mailbox — and nothing else. A signed-in caller, or anything holding a service
 * token, could hammer search, the cross-mailbox person fan-out (one Durable Object
 * call per mailbox) or MCP, whose tools reach Workers AI and the send path.
 *
 * Two properties are pinned here. Budgets are charged per *caller*, because the
 * app sits behind Access and a team behind one office NAT must not share one
 * bucket while an attacker with a credential can change address freely. And a
 * missing or broken limiter must fail *open*: the boundary protecting the data is
 * Access plus authorization, and a limiter that can take the mailbox offline
 * through misconfiguration is worse than no limiter.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
	rateLimitGuard,
	rateLimitKey,
	type RateLimiterBinding,
} from "../workers/lib/rate-limit";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";
import type { Principal } from "../workers/lib/authz";

const MEMBER = "member@tapetide.com";
const SERVICE = "e367826f93b8d71185e03fe518aff3b4.access";

describe("rateLimitKey", () => {
	it("charges a person their own budget", () => {
		expect(
			rateLimitKey({ bucket: "api", principalKind: "user", principalId: MEMBER }),
		).toBe(`api:user:${MEMBER}`);
	});

	it("keeps the two buckets separate", () => {
		// A busy UI must not be able to spend the budget that bounds MCP.
		const forApi = rateLimitKey({ bucket: "api", principalId: MEMBER });
		const forMcp = rateLimitKey({ bucket: "mcp", principalId: MEMBER });

		expect(forApi).not.toBe(forMcp);
	});

	it("keeps a person and a machine apart even on the same identifier", () => {
		expect(
			rateLimitKey({ bucket: "api", principalKind: "user", principalId: "shared" }),
		).not.toBe(
			rateLimitKey({
				bucket: "api",
				principalKind: "service",
				principalId: "shared",
			}),
		);
	});

	it("falls back to the IP only when the request is unattributed", () => {
		expect(rateLimitKey({ bucket: "api", ip: "203.0.113.7" })).toBe(
			"api:ip:203.0.113.7",
		);
	});

	it("prefers the principal over the IP", () => {
		// Otherwise a team behind one NAT would share a budget.
		expect(
			rateLimitKey({
				bucket: "api",
				principalKind: "service",
				principalId: SERVICE,
				ip: "203.0.113.7",
			}),
		).toBe(`api:service:${SERVICE}`);
	});

	it("has a last resort that cannot collide with a real principal", () => {
		expect(rateLimitKey({ bucket: "api" })).toBe("api:anonymous");
	});
});

// -- Middleware ------------------------------------------------------

function principalFor(id: string | null): Principal {
	return {
		identity: id ? { kind: "user", id, subject: null } : null,
		role: "member",
		mailboxes: [],
		enforced: true,
		developmentBypass: false,
	};
}

/** Records the keys it was asked about, and allows the first `allow` calls. */
function countingLimiter(allow: number) {
	const keys: string[] = [];
	const used = new Map<string, number>();

	const binding: RateLimiterBinding = {
		async limit({ key }) {
			keys.push(key);
			const count = (used.get(key) ?? 0) + 1;
			used.set(key, count);
			return { success: count <= allow };
		},
	};

	return { binding, keys };
}

function buildApp(options: {
	limiter?: RateLimiterBinding;
	identityId?: string | null;
	ip?: string;
}) {
	const app = new Hono<MailboxContext>();

	app.use("*", async (c, next) => {
		c.set("principal", principalFor(options.identityId ?? null));
		return next();
	});

	app.use(
		"/api/*",
		rateLimitGuard({
			bucket: "api",
			bindingName: "API_RATE_LIMITER",
			select: () => options.limiter,
			retryAfterSeconds: 60,
		}),
	);

	app.get("/api/v1/config", (c) => c.json({ ok: true }));

	return () =>
		app.fetch(
			new Request("https://mailer.tapetide.com/api/v1/config", {
				headers: options.ip ? { "cf-connecting-ip": options.ip } : {},
			}),
			{} as Env,
		);
}

describe("rateLimitGuard", () => {
	it("allows requests under the budget", async () => {
		const { binding } = countingLimiter(2);
		const request = buildApp({ limiter: binding, identityId: MEMBER });

		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(200);
	});

	it("refuses with 429 and a Retry-After once over", async () => {
		const { binding } = countingLimiter(1);
		const request = buildApp({ limiter: binding, identityId: MEMBER });

		await request();
		const res = await request();

		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("60");
		await expect(res.json()).resolves.toEqual({
			error: "Too many requests. Slow down and retry.",
		});
	});

	it("charges the identity, not the address", async () => {
		const { binding, keys } = countingLimiter(10);
		const request = buildApp({
			limiter: binding,
			identityId: MEMBER,
			ip: "203.0.113.7",
		});

		await request();
		expect(keys).toEqual([`api:user:${MEMBER}`]);
	});

	it("falls back to the address when there is no identity", async () => {
		const { binding, keys } = countingLimiter(10);
		const request = buildApp({
			limiter: binding,
			identityId: null,
			ip: "203.0.113.7",
		});

		await request();
		expect(keys).toEqual(["api:ip:203.0.113.7"]);
	});

	it("gives separate callers separate budgets", async () => {
		const { binding } = countingLimiter(1);

		const first = buildApp({ limiter: binding, identityId: MEMBER });
		const second = buildApp({ limiter: binding, identityId: "other@tapetide.com" });

		expect((await first()).status).toBe(200);
		// Exhausted for the first caller, untouched for the second.
		expect((await first()).status).toBe(429);
		expect((await second()).status).toBe(200);
	});

	it("runs unlimited when the binding is absent", async () => {
		// A deployment whose account or config lacks rate limiting must still work.
		const request = buildApp({ limiter: undefined, identityId: MEMBER });

		for (let i = 0; i < 5; i += 1) {
			expect((await request()).status).toBe(200);
		}
	});

	it("allows the request when the limiter itself throws", async () => {
		// Failing closed here would let a limiter outage take the mailbox offline.
		const exploding: RateLimiterBinding = {
			async limit() {
				throw new Error("limiter unavailable");
			},
		};
		const request = buildApp({ limiter: exploding, identityId: MEMBER });

		expect((await request()).status).toBe(200);
	});
});
