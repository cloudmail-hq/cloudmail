// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Optional Cloudflare Turnstile check on the unauthenticated forms (login,
 * setup, invite acceptance).
 *
 * Off unless both keys are configured, so a deployment works with zero setup.
 * Once on it fails closed: a missing token, a Turnstile outage or a timeout all
 * refuse the request. An operator who enabled a bot check wants it to hold
 * during the moment someone is trying to get around it.
 */

import type { Env } from "../types";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 10_000;

type TurnstileEnv = Pick<Env, "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY">;

export function turnstileEnabled(env: TurnstileEnv): boolean {
	return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/** The site key to hand the browser, or null when the check is off. */
export function turnstileSiteKey(env: TurnstileEnv): string | null {
	return turnstileEnabled(env) ? env.TURNSTILE_SITE_KEY! : null;
}

/**
 * Whether the request may proceed. Always true when Turnstile is not configured.
 *
 * `fetchImpl` is injectable for tests; production uses the global fetch.
 */
export async function verifyTurnstile(
	env: TurnstileEnv,
	token: string | undefined | null,
	remoteIp: string | null,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	if (!turnstileEnabled(env)) return true;
	if (!token || token.length > 2048) return false;

	const body = new FormData();
	body.append("secret", env.TURNSTILE_SECRET_KEY!);
	body.append("response", token);
	if (remoteIp) body.append("remoteip", remoteIp);

	try {
		const res = await fetchImpl(SITEVERIFY_URL, {
			method: "POST",
			body,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) return false;
		const outcome = (await res.json()) as { success?: unknown };
		return outcome.success === true;
	} catch (e) {
		console.error("Turnstile verification failed, refusing:", (e as Error).message);
		return false;
	}
}
