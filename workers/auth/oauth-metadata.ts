// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The pure, dependency-free half of MCP OAuth: names, URLs and the challenge.
 *
 * Kept apart from `oauth.ts` so the auth middleware can build the `401`
 * challenge without importing `@cloudflare/workers-oauth-provider`, which pulls
 * in `cloudflare:workers` and would make every middleware test need a runtime.
 *
 * The deployment is its own authorization server and its only protected
 * resource is the MCP endpoint, so everything here is derived from the request
 * origin: issuer `<origin>`, resource `<origin>/mcp`. A token is therefore bound
 * to the host it was issued on, and never to `/api/*`.
 */

import type { Env } from "../types";
import { resolveAuthMode } from "./config";

/** The one scope we grant: "act as me over MCP". Finer scopes would be decorative, see oauth.ts. */
export const MCP_SCOPE = "mcp";

export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const PRM_PATH = "/.well-known/oauth-protected-resource";
/** RFC 9728 §3.1: the resource's path is appended to the well-known prefix. */
export const MCP_PRM_PATH = `${PRM_PATH}/mcp`;

/** The canonical resource identifier (RFC 8707 audience) of the MCP endpoint. */
export function mcpResource(origin: string): string {
	return `${origin}/mcp`;
}

export function mcpResourceMetadataUrl(origin: string): string {
	return `${origin}${MCP_PRM_PATH}`;
}

/**
 * Whether this request may use MCP OAuth at all.
 *
 * Password mode only: the consent page needs a built-in account to approve
 * with, and an Access deployment already puts Cloudflare Access in front of
 * `/mcp`. Without the KV namespace (a deployment that has not picked up the new
 * binding yet) everything OAuth-shaped stays off rather than throwing, so
 * `ttk_` tokens keep working regardless.
 */
export function mcpOAuthEnabled(env: Env): boolean {
	return resolveAuthMode(env) === "password" && Boolean((env as { OAUTH_KV?: unknown }).OAUTH_KV);
}

/** RFC 9728 protected resource metadata for `/mcp`. */
export function protectedResourceMetadata(origin: string) {
	return {
		resource: mcpResource(origin),
		authorization_servers: [origin],
		scopes_supported: [MCP_SCOPE],
		bearer_methods_supported: ["header"],
		resource_name: "cloudmail MCP",
	};
}

/**
 * `WWW-Authenticate` for an unauthenticated `/mcp` request (RFC 6750 §3, RFC
 * 9728 §5.1). This header is how an MCP client learns that it can sign in with
 * OAuth instead of failing; without it the client just reports a 401.
 *
 * `invalidToken` adds `error="invalid_token"` when a bearer was presented, so a
 * client holding an expired access token knows to refresh rather than start
 * over.
 */
export function mcpBearerChallenge(origin: string, invalidToken: boolean): string {
	let challenge = `Bearer realm="OAuth", resource_metadata="${mcpResourceMetadataUrl(origin)}", scope="${MCP_SCOPE}"`;
	if (invalidToken) challenge += `, error="invalid_token"`;
	return challenge;
}

/** `Authorization: Bearer <token>` with a token that is not a `ttk_` API token. */
export function oauthBearerFrom(header: string | null | undefined): string | null {
	if (!header) return null;
	const match = /^Bearer[\t ]+(\S+)$/i.exec(header.trim());
	if (!match) return null;
	return match[1].startsWith("ttk_") ? null : match[1];
}
