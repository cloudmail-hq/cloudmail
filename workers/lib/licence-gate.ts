/**
 * The API side of the licence lock (`./licence.ts` decides the state).
 *
 * Mounted in workers/app.ts right after the auth gate. Only API surfaces are
 * gated (`/api`, `/mcp`, `/agents`): pages are an SPA shell with no server
 * loaders, so they carry no data, and the shell shows the "Activate your
 * licence" screen when the API answers 402.
 *
 * Never gated, because they run before this middleware in workers/app.ts and
 * serve recipients rather than the customer: `/t/` tracking, `/u/`
 * unsubscribe, `/privacy`, `/p/` product logos, `/push/` notification actions,
 * `/img/` image proxy. Static assets never reach the Worker. The inbound
 * `email()` handler is not HTTP at all and never checks the licence.
 *
 * Exempt here: sign-in and account endpoints (`/api/auth/*`), the licence
 * endpoints themselves, `GET /api/v1/me` (exact: the UI needs the role to
 * choose between the key form and "Ask your admin"), the Cloudflare
 * connection (the onboarding step before the licence step), and the
 * public API reads the login page uses.
 */

import type { MiddlewareHandler } from "hono";
import { isApiPath } from "../auth/middleware";
import { LICENCE_REQUIRED_CODE, LICENCE_REQUIRED_MESSAGE } from "../../shared/licence";
import type { MailboxContext } from "./mailbox";
import { LicenceUnavailableError, bootLicenceCheck, enforcementMode, isLicenceLocked } from "./licence";

/** Paths that stay reachable while locked. Exact matches, then prefixes. */
const EXEMPT_EXACT = new Set([
	"/api/v1/me",
	"/api/v1/licence",
	"/api/v1/cloudflare/connection",
	"/api/v1/branding",
	"/api/v1/branding/logo",
	"/api/v1/openapi.json",
	"/api/docs",
]);
const EXEMPT_PREFIXES = ["/api/auth/", "/api/v1/licence/"];
/**
 * Under `/api/auth/` but gated: managing other people's accounts and minting
 * API tokens are features of the app, not what you need to sign in and
 * activate. Signing in, out, setup, recovery, password, 2FA, passkeys and
 * your own sessions stay open.
 */
const GATED_AUTH_PREFIXES = ["/api/auth/admin/", "/api/auth/tokens", "/api/auth/oauth-grants"];
/** Exempt for reads only (GET/HEAD). */
const READ_ONLY_EXEMPT = new Set(["/api/v1/me", "/api/v1/branding", "/api/v1/branding/logo", "/api/v1/openapi.json", "/api/docs"]);

export function isLicenceExempt(method: string, pathname: string): boolean {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	if (!isApiPath(path)) return true;
	if (EXEMPT_EXACT.has(path)) {
		return READ_ONLY_EXEMPT.has(path) ? method === "GET" || method === "HEAD" : true;
	}
	if (GATED_AUTH_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))) return false;
	return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function licenceRequiredBody() {
	return { error: LICENCE_REQUIRED_MESSAGE, code: LICENCE_REQUIRED_CODE };
}

export const licenceGate: MiddlewareHandler<MailboxContext> = async (c, next) => {
	if (enforcementMode(c.env) === "off") return next();
	bootLicenceCheck(c.env, (p) => c.executionCtx.waitUntil(p));
	const pathname = new URL(c.req.url).pathname;
	if (isLicenceExempt(c.req.method, pathname)) return next();
	let locked: boolean;
	try {
		locked = await isLicenceLocked(c.env);
	} catch (e) {
		if (!(e instanceof LicenceUnavailableError)) throw e;
		console.error(e.message);
		return c.json({ error: "Licence status is unavailable. Try again shortly.", code: "licence_unavailable" }, 503);
	}
	if (!locked) return next();
	return c.json(licenceRequiredBody(), 402);
};
