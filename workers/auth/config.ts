// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Deployment-level authentication settings.
 *
 * Everything here is derived from env vars and secrets, plus two values the
 * AuthDO can generate and persist when the operator did not configure them
 * (the first-run setup token and the TOTP encryption key). Kept apart from the
 * middleware and routes so the decisions — which mode, which base URL, which
 * secret — are each made in exactly one place.
 */

import { randomToken } from "./crypto";
import type { AuthMode, AuthStoreApi } from "./types";
import type { Env } from "../types";
import { getDomains } from "../lib/zones";

type AuthEnv = Pick<
	Env,
	| "AUTH_MODE"
	| "POLICY_AUD"
	| "TEAM_DOMAIN"
	| "DEV_AUTH_BYPASS"
	| "APP_URL"
	| "SETUP_TOKEN"
	| "AUTH_SECRET"
>;

/**
 * Which authentication this deployment uses.
 *
 * An explicit `AUTH_MODE` wins. Without one, a deployment that already has both
 * Access settings is assumed to be an Access deployment — the shape every
 * install had before built-in accounts existed — so upgrading does not silently
 * swap its login for a setup screen. Everything else gets password mode, which
 * needs no configuration to start.
 *
 * An unrecognised `AUTH_MODE` value falls back to password rather than access:
 * password mode is the one that fails closed without further configuration,
 * whereas access mode without POLICY_AUD would refuse every request.
 */
export function resolveAuthMode(env: AuthEnv): AuthMode {
	const explicit = env.AUTH_MODE?.trim().toLowerCase();
	if (explicit === "password" || explicit === "access") return explicit;
	if (explicit) {
		console.warn(`Unknown AUTH_MODE "${env.AUTH_MODE}", using "password".`);
		return "password";
	}
	return env.POLICY_AUD && env.TEAM_DOMAIN ? "access" : "password";
}

/**
 * Whether the all-admin localhost bypass applies.
 *
 * Requires *both* a development build and the opt-in var, so a `.dev.vars`
 * copied into production secrets cannot reopen it: `import.meta.env.DEV` is a
 * build-time constant that is false in every deployed bundle.
 */
export function isDevBypass(env: Pick<Env, "DEV_AUTH_BYPASS">, isDev: boolean): boolean {
	return isDev && env.DEV_AUTH_BYPASS === "1";
}

/**
 * Origin used to build invite and reset links.
 *
 * `APP_URL` exists for deployments reached through more than one hostname,
 * where the admin's current origin may not be the one the invitee should use.
 * A malformed value is ignored rather than producing unusable links.
 */
export function appBaseUrl(env: Pick<Env, "APP_URL">, requestUrl: string): string {
	const configured = env.APP_URL?.trim();
	if (configured) {
		try {
			const url = new URL(configured);
			if (url.protocol === "https:" || url.protocol === "http:") {
				return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
			}
		} catch {
			/* fall through */
		}
		console.warn(`APP_URL "${configured}" is not a valid http(s) URL; using the request origin.`);
	}
	return new URL(requestUrl).origin;
}

/**
 * Values that are documented or shipped as examples, and so are public.
 *
 * The Deploy to Cloudflare button builds its secrets form from
 * `.dev.vars.example`, and people copy `.dev.vars` into production. A
 * deployment whose setup token is a value printed in this repository can be
 * claimed by anyone who reads it, so these count as not configured: setup falls
 * back to a generated token that only the Worker logs show.
 */
const PLACEHOLDER_SECRETS = new Set([
	"dev-setup-token",
	"dev-auth-secret-change-me-0123456789abcdef",
	"change-me",
	"changeme",
]);

export function isPlaceholderSecret(value: string | undefined | null): boolean {
	return typeof value === "string" && PLACEHOLDER_SECRETS.has(value.trim().toLowerCase());
}

/** Whether the operator set a real `SETUP_TOKEN` secret. */
export function setupTokenConfigured(env: Pick<Env, "SETUP_TOKEN">): boolean {
	const value = env.SETUP_TOKEN?.trim();
	if (!value) return false;
	if (isPlaceholderSecret(value)) {
		warnPlaceholderOnce("SETUP_TOKEN");
		return false;
	}
	return true;
}

const warnedPlaceholders = new Set<string>();

function warnPlaceholderOnce(name: string): void {
	if (warnedPlaceholders.has(name)) return;
	warnedPlaceholders.add(name);
	console.warn(
		`${name} is set to an example value from this repository, so it is being ignored. ` +
			"Generate a real one with `npm run secrets`.",
	);
}

/** Shortest `SETUP_TOKEN` that may guard break-glass owner recovery. */
export const RECOVERY_TOKEN_MIN_LENGTH = 16;

/**
 * Whether `SETUP_TOKEN` is strong enough to enable `/recover`. Setup itself
 * accepts any value (it is open only until the owner exists), but recovery
 * resets the owner at any time, so a short, guessable token is refused.
 */
export function recoveryTokenUsable(env: Pick<Env, "SETUP_TOKEN">): boolean {
	return setupTokenConfigured(env) && env.SETUP_TOKEN!.trim().length >= RECOVERY_TOKEN_MIN_LENGTH;
}

/**
 * The token first-run setup must present.
 *
 * The configured secret when there is one. Otherwise a random token generated
 * once and persisted in the AuthDO, so it survives isolate restarts and the
 * value in the logs keeps working until someone uses it.
 */
export async function resolveSetupToken(
	env: Pick<Env, "SETUP_TOKEN">,
	store: Pick<AuthStoreApi, "ensureGeneratedSetupToken">,
): Promise<string> {
	if (setupTokenConfigured(env)) return env.SETUP_TOKEN!.trim();
	return store.ensureGeneratedSetupToken();
}

/**
 * Print the generated setup token where only the operator can see it.
 *
 * The Worker logs (`wrangler tail`, the dashboard) are readable only by people
 * with access to the Cloudflare account — the same people who could have set
 * `SETUP_TOKEN` themselves — so this is a delivery channel, never a leak. It is
 * never returned over HTTP: whoever first reached a fresh deployment would
 * otherwise own it.
 */
export function logGeneratedSetupToken(token: string): void {
	console.warn(
		`[cloudmail] First-run setup is pending. Setup token: ${token} — enter it at /setup ` +
			`to create the owner account. Set a SETUP_TOKEN secret to choose your own ` +
			`(and to enable /recover).`,
	);
}

let warnedGeneratedSecret = false;

/**
 * Key material for encrypting TOTP secrets.
 *
 * `AUTH_SECRET` keeps the key out of the AuthDO, so a copy of its storage alone
 * cannot mint second-factor codes. Without it the key is generated and stored
 * beside the data it protects: still encrypted, still unique per deployment,
 * but weaker, hence the warning.
 */
export async function authSecret(
	env: Pick<Env, "AUTH_SECRET">,
	store: Pick<AuthStoreApi, "getOrInitMeta">,
): Promise<string> {
	if (env.AUTH_SECRET && env.AUTH_SECRET.trim()) {
		if (!isPlaceholderSecret(env.AUTH_SECRET)) return env.AUTH_SECRET;
		warnPlaceholderOnce("AUTH_SECRET");
	}
	if (!warnedGeneratedSecret) {
		warnedGeneratedSecret = true;
		console.warn(
			"AUTH_SECRET is not set; using a generated key stored in the AuthDO to encrypt " +
				"2FA secrets. Set an AUTH_SECRET secret for stronger protection at rest.",
		);
	}
	return store.getOrInitMeta("auth_secret", randomToken(32));
}

/** The From of password reset emails. `name` is null when only an address is known. */
export interface AuthEmailSender {
	email: string;
	name: string | null;
}

// Deliberately loose: Email Service is the real validator. This only keeps a
// typo in `AUTH_EMAIL_FROM` from becoming a send that fails on every request.
const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** `Name <addr>` or a bare `addr`; null when it is neither. */
function parseFromHeader(raw: string): AuthEmailSender | null {
	const value = raw.trim();
	const angled = /^(.*?)\s*<([^<>]+)>$/.exec(value);
	if (angled) {
		const email = angled[2].trim().toLowerCase();
		if (!ADDRESS_RE.test(email)) return null;
		// Quotes are the header's syntax, not part of the name.
		const name = angled[1].trim().replace(/^"(.*)"$/, "$1").trim();
		return { email, name: name || null };
	}
	return ADDRESS_RE.test(value) ? { email: value.toLowerCase(), name: null } : null;
}

let warnedBadFrom = false;

/**
 * Where password reset emails come from, or null when they cannot be sent.
 *
 * `AUTH_EMAIL_FROM` when set and well formed. Otherwise `no-reply@` the first
 * configured domain: that domain already receives this deployment's mail, so
 * it is the one most likely to be onboarded for sending too. Null without an
 * `EMAIL` binding or any domain, and that null is the switch that turns the
 * feature off — the sign-in page then keeps telling people to ask an
 * administrator instead of offering a form that would silently send nothing.
 */
export function resolveAuthEmailSender(
	env: Pick<Env, "AUTH_EMAIL_FROM" | "DOMAINS" | "ZONES" | "EMAIL">,
): AuthEmailSender | null {
	if (!env.EMAIL) return null;
	const configured = env.AUTH_EMAIL_FROM?.trim();
	if (configured) {
		const parsed = parseFromHeader(configured);
		if (parsed) return parsed;
		if (!warnedBadFrom) {
			warnedBadFrom = true;
			console.warn(
				`AUTH_EMAIL_FROM "${configured}" is not "Name <address>" or an address; ` +
					"falling back to no-reply@ the first configured domain.",
			);
		}
	}
	const domain = getDomains(env as Env)[0];
	return domain ? { email: `no-reply@${domain}`, name: null } : null;
}
