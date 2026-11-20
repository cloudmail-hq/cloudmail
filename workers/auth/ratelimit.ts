// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Burst limiting for the credential endpoints.
 *
 * Keyed by client IP, and for sign-in by (email, IP). Never by email alone: a
 * global per-account key is a lever anyone who knows an address can pull to
 * keep its owner from signing in. Each key is prefixed with the endpoint, so a
 * burst of logins does not spend the budget of an invite acceptance.
 *
 * Fails open, like `workers/lib/rate-limit.ts`: this binding is burst
 * protection. The real backstops live in the AuthDO and need no binding: the
 * (email, IP) password lockout, the per-account second-factor lockout, and the
 * global cap on break-glass recovery.
 */

import type { RateLimiterBinding } from "../lib/rate-limit";

/** Seconds to advertise in `Retry-After`; matches the binding's period. */
export const AUTH_RATE_LIMIT_PERIOD_SECONDS = 60;

let warned = false;

/** True when the request may proceed. */
export async function authLimit(
	env: { AUTH_RATE_LIMITER?: RateLimiterBinding },
	key: string,
): Promise<boolean> {
	const limiter = env.AUTH_RATE_LIMITER;
	if (!limiter) {
		if (!warned) {
			warned = true;
			console.warn(
				"AUTH_RATE_LIMITER is not bound, so sign-in rate limiting is disabled. " +
					"Sign-in lockouts still apply.",
			);
		}
		return true;
	}
	try {
		return (await limiter.limit({ key: `auth:${key}` })).success;
	} catch (e) {
		console.error("AUTH_RATE_LIMITER failed, allowing the request:", (e as Error).message);
		return true;
	}
}

/** Check every key; the first refusal wins. All keys are charged. */
export async function authLimitAll(
	env: { AUTH_RATE_LIMITER?: RateLimiterBinding },
	keys: string[],
): Promise<boolean> {
	const results = await Promise.all(keys.map((key) => authLimit(env, key)));
	return results.every(Boolean);
}
