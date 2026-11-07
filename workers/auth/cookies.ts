// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The session cookie.
 *
 * On https it is `__Host-tt_session`: the prefix makes the browser refuse the
 * cookie unless it is Secure, host-only and `Path=/`, so a sibling subdomain
 * cannot plant or shadow it. Browsers also refuse Secure cookies over plain
 * http, which is what `wrangler dev` / `react-router dev` serve on localhost,
 * so there it falls back to a plain `tt_session` without Secure.
 *
 * SameSite=Lax rather than Strict so following a link to the app from another
 * site (an invite in a chat) arrives signed in; cross-site *writes* are refused
 * independently by `csrfGuard`.
 */

export const SECURE_COOKIE_NAME = "__Host-tt_session";
export const INSECURE_COOKIE_NAME = "tt_session";

/** Max-Age matching the absolute session lifetime (30 days). */
export const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function isHttps(requestUrl: string): boolean {
	return new URL(requestUrl).protocol === "https:";
}

export function sessionCookieName(requestUrl: string): string {
	return isHttps(requestUrl) ? SECURE_COOKIE_NAME : INSECURE_COOKIE_NAME;
}

function attributes(requestUrl: string, maxAge: number): string {
	const parts = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
	if (isHttps(requestUrl)) parts.push("Secure");
	return parts.join("; ");
}

/** `Set-Cookie` value for a freshly issued session token. */
export function buildSessionCookie(token: string, requestUrl: string): string {
	return `${sessionCookieName(requestUrl)}=${token}; ${attributes(requestUrl, SESSION_COOKIE_MAX_AGE)}`;
}

/** `Set-Cookie` value that removes the session cookie. */
export function clearSessionCookie(requestUrl: string): string {
	return `${sessionCookieName(requestUrl)}=; ${attributes(requestUrl, 0)}`;
}

/**
 * The session token from a `Cookie` header, or null.
 *
 * Reads only the name for this scheme: on https a plain `tt_session` could have
 * been set by anything able to write cookies for the host over http, which is
 * exactly what the `__Host-` prefix exists to exclude.
 */
export function readSessionCookie(cookieHeader: string | null | undefined, requestUrl: string): string | null {
	if (!cookieHeader) return null;
	const name = sessionCookieName(requestUrl);
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() !== name) continue;
		const value = part.slice(eq + 1).trim();
		// Tokens are base64url; anything else is not one we issued.
		return /^[A-Za-z0-9_-]{16,256}$/.test(value) ? value : null;
	}
	return null;
}
