// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The pure decisions behind built-in auth: which mode a deployment is in, which
 * paths are public, how credentials are parsed, and — the property the whole
 * change rests on — that password mode is always enforced, so "nobody set
 * ADMIN_EMAILS" can never again mean "everyone is an administrator".
 *
 * The HTTP flows are in `test/auth-routes.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	appBaseUrl,
	authSecret,
	isDevBypass,
	isPlaceholderSecret,
	recoveryTokenUsable,
	resolveAuthMode,
	resolveSetupToken,
	setupTokenConfigured,
} from "../workers/auth/config";
import { buildSessionCookie, clearSessionCookie, readSessionCookie } from "../workers/auth/cookies";
import { isApiPath, isPublicPage, isStaticPath, parseBearerToken } from "../workers/auth/middleware";
import { authLimit } from "../workers/auth/ratelimit";
import { decidePrincipal, principalFromProps, resolvePrincipalFor } from "../workers/lib/authz";

const HTTPS = "https://mail.example.com/x";
const HTTP = "http://localhost:5173/x";

describe("resolveAuthMode", () => {
	it("honours an explicit AUTH_MODE", () => {
		expect(resolveAuthMode({ AUTH_MODE: "access" })).toBe("access");
		expect(resolveAuthMode({ AUTH_MODE: " Password ", POLICY_AUD: "a", TEAM_DOMAIN: "t" })).toBe("password");
	});

	it("keeps an existing Access deployment on Access", () => {
		expect(resolveAuthMode({ POLICY_AUD: "aud", TEAM_DOMAIN: "https://t.cloudflareaccess.com" })).toBe("access");
	});

	it("defaults to password otherwise, including half-configured Access", () => {
		expect(resolveAuthMode({})).toBe("password");
		expect(resolveAuthMode({ POLICY_AUD: "aud" })).toBe("password");
	});

	it("falls back to password for an unknown value", () => {
		expect(resolveAuthMode({ AUTH_MODE: "sso" })).toBe("password");
	});
});

describe("isDevBypass", () => {
	it("needs both a development build and the opt-in", () => {
		expect(isDevBypass({ DEV_AUTH_BYPASS: "1" }, true)).toBe(true);
		expect(isDevBypass({ DEV_AUTH_BYPASS: "1" }, false)).toBe(false);
		expect(isDevBypass({}, true)).toBe(false);
		expect(isDevBypass({ DEV_AUTH_BYPASS: "true" }, true)).toBe(false);
	});
});

describe("example secrets", () => {
	// The Deploy button builds its form from .dev.vars.example, and people copy
	// .dev.vars into production. A token printed in the repository is public.
	const store = {
		ensureGeneratedSetupToken: async () => "generated-token",
		getOrInitMeta: async (_key: string, fallback: string) => `stored:${fallback.length}`,
	};

	it("treats a shipped example SETUP_TOKEN as unset", async () => {
		for (const value of ["dev-setup-token", " DEV-SETUP-TOKEN ", "change-me"]) {
			expect(isPlaceholderSecret(value), value).toBe(true);
			expect(setupTokenConfigured({ SETUP_TOKEN: value }), value).toBe(false);
			expect(recoveryTokenUsable({ SETUP_TOKEN: value }), value).toBe(false);
			expect(await resolveSetupToken({ SETUP_TOKEN: value }, store), value).toBe("generated-token");
		}
	});

	it("accepts a real SETUP_TOKEN", async () => {
		const value = "Zs3r8xPq1vN0bT6yLw2cK9mD";
		expect(setupTokenConfigured({ SETUP_TOKEN: value })).toBe(true);
		expect(recoveryTokenUsable({ SETUP_TOKEN: value })).toBe(true);
		expect(await resolveSetupToken({ SETUP_TOKEN: value }, store)).toBe(value);
	});

	it("does not encrypt 2FA secrets under an example AUTH_SECRET", async () => {
		const placeholder = "dev-auth-secret-change-me-0123456789abcdef";
		expect(await authSecret({ AUTH_SECRET: placeholder }, store)).toMatch(/^stored:/);
		expect(await authSecret({ AUTH_SECRET: "a-real-secret-value" }, store)).toBe("a-real-secret-value");
	});

	it("is not tripped by a value that merely contains a placeholder", () => {
		expect(isPlaceholderSecret("dev-setup-token-9f8e7d6c5b4a")).toBe(false);
		expect(isPlaceholderSecret(undefined)).toBe(false);
	});
});

describe("appBaseUrl", () => {
	it("defaults to the request origin", () => {
		expect(appBaseUrl({}, "https://mail.example.com/api/auth/x?y")).toBe("https://mail.example.com");
	});

	it("uses APP_URL without a trailing slash, and ignores a bad one", () => {
		expect(appBaseUrl({ APP_URL: "https://inbox.example.org/" }, HTTPS)).toBe("https://inbox.example.org");
		expect(appBaseUrl({ APP_URL: "javascript:alert(1)" }, HTTPS)).toBe("https://mail.example.com");
	});
});

describe("session cookie", () => {
	it("is __Host- prefixed and Secure on https", () => {
		const cookie = buildSessionCookie("tok", HTTPS);
		expect(cookie).toBe("__Host-tt_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure");
		expect(clearSessionCookie(HTTPS)).toContain("Max-Age=0");
	});

	it("reads only the name for the scheme", () => {
		const token = "A".repeat(43);
		expect(readSessionCookie(`a=b; __Host-tt_session=${token}`, HTTPS)).toBe(token);
		// A plain cookie could be planted over http; https must not accept it.
		expect(readSessionCookie(`tt_session=${token}`, HTTPS)).toBeNull();
		expect(readSessionCookie(`tt_session=${token}`, HTTP)).toBe(token);
		expect(readSessionCookie(`__Host-tt_session=<script>`, HTTPS)).toBeNull();
		expect(readSessionCookie(null, HTTPS)).toBeNull();
	});
});

describe("parseBearerToken", () => {
	it("splits ttk_<id>_<secret>, where the secret may contain underscores", () => {
		const secret = "abc_DEF-ghi_jklmnopqrstuvwxyz0123456789AB";
		expect(parseBearerToken(`Bearer ttk_AbCdEf123456_${secret}`)).toEqual({ id: "AbCdEf123456", secret });
	});

	it("refuses anything else", () => {
		expect(parseBearerToken(undefined)).toBeNull();
		expect(parseBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
		expect(parseBearerToken("Bearer eyJhbGciOi.jwt.value")).toBeNull();
		expect(parseBearerToken("Bearer ttk_short_secretsecretsecretsecret")).toBeNull();
	});
});

describe("public paths", () => {
	it("treats static files and dev-server internals as static", () => {
		for (const path of [
			"/assets/root-abc.js",
			"/assets/app.css",
			"/__manifest",
			"/@vite/client",
			"/node_modules/.vite/deps/react.js",
			"/app/root.tsx",
			"/favicon.ico",
			"/favicon.svg",
			"/icon-512-maskable.png",
			"/manifest.webmanifest",
		]) {
			expect(isStaticPath(path), path).toBe(true);
		}
	});

	it("does not mistake a mailbox page for a file", () => {
		// Mailbox ids are addresses, so these end in a TLD.
		expect(isStaticPath("/mail/support@example.com")).toBe(false);
		expect(isStaticPath("/mail/support@example.com/inbox")).toBe(false);
		expect(isStaticPath("/settings")).toBe(false);
		expect(isStaticPath("/settings.data")).toBe(false);
	});

	it("never treats an API path as static, whatever it ends in", () => {
		for (const path of ["/api/v1/x.js", "/api/v1/branding/logo.png", "/mcp/x.css", "/mcp", "/agents/a/b/x.png"]) {
			expect(isApiPath(path), path).toBe(true);
			expect(isStaticPath(path), path).toBe(false);
		}
		expect(isApiPath("/apix.js")).toBe(false);
		expect(isApiPath("/assets/api.js")).toBe(false);
	});

	it("knows the sign-in pages", () => {
		for (const path of ["/login", "/login/", "/setup", "/recover", "/forgot", "/invite/abc", "/reset/abc"]) {
			expect(isPublicPage(path), path).toBe(true);
		}
		for (const path of ["/", "/settings", "/invite", "/invite/a/b", "/loginx"]) {
			expect(isPublicPage(path), path).toBe(false);
		}
	});
});

describe("authLimit", () => {
	it("fails open without a binding and when the binding errors", async () => {
		expect(await authLimit({}, "k")).toBe(true);
		const broken = {
			limit: async () => {
				throw new Error("down");
			},
		};
		expect(await authLimit({ AUTH_RATE_LIMITER: broken }, "k")).toBe(true);
	});

	it("namespaces the key and reports the verdict", async () => {
		const seen: string[] = [];
		const limiter = {
			limit: async ({ key }: { key: string }) => {
				seen.push(key);
				return { success: false };
			},
		};
		expect(await authLimit({ AUTH_RATE_LIMITER: limiter }, "login:ip:1.2.3.4")).toBe(false);
		expect(seen).toEqual(["auth:login:ip:1.2.3.4"]);
	});
});

// -- enforcement --------------------------------------------------------------

const MEMBER = { kind: "user" as const, id: "member@example.com", subject: "usr_1" };

describe("forceEnforced", () => {
	it("is what stops an empty ADMIN_EMAILS meaning 'everyone is admin'", () => {
		// The legacy Access behaviour, unchanged.
		expect(decidePrincipal({ adminEmails: [], identity: MEMBER })).toMatchObject({
			role: "admin",
			enforced: false,
		});
		// Password mode.
		expect(decidePrincipal({ adminEmails: [], identity: MEMBER, forceEnforced: true })).toMatchObject({
			role: "member",
			mailboxes: [],
			enforced: true,
		});
	});

	it("denies an anonymous caller", () => {
		expect(decidePrincipal({ adminEmails: [], identity: null, forceEnforced: true })).toMatchObject({
			role: "member",
			mailboxes: [],
			identity: null,
		});
	});

	it("still honours grants and configured admins", () => {
		const grant = {
			id: MEMBER.id,
			kind: "user" as const,
			role: "member" as const,
			mailboxes: ["support@example.com"],
			access: [],
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		expect(decidePrincipal({ adminEmails: [], identity: MEMBER, grant, forceEnforced: true }).mailboxes).toEqual([
			"support@example.com",
		]);
		expect(decidePrincipal({ adminEmails: [MEMBER.id], identity: MEMBER, forceEnforced: true }).role).toBe("admin");
	});

	it("lets the owner be admin through extraAdminEmails without a grant read", async () => {
		const bucket = {
			get: async () => {
				throw new Error("should not read a grant for an admin");
			},
		} as unknown as R2Bucket;
		const principal = await resolvePrincipalFor({
			adminEmailsRaw: undefined,
			bucket,
			identity: { kind: "user", id: "Owner@Example.com", subject: "usr_o" },
			forceEnforced: true,
			extraAdminEmails: ["owner@example.com"],
		});
		expect(principal).toMatchObject({ role: "admin", enforced: true, mailboxes: null });
	});

	it("makes absent MCP props deny in password mode", () => {
		expect(principalFromProps(undefined, undefined).role).toBe("admin");
		expect(principalFromProps(undefined, undefined, { forceEnforced: true })).toMatchObject({
			role: "member",
			mailboxes: [],
		});
	});
});
